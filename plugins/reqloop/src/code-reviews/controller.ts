import type {
  BatonSnapshot,
  Controller,
  ResourceClient,
  Source,
} from "@compforge/baton-plugin";

import { boardPriority } from "../board.ts";
import {
  actionableCodeReview,
  CODE_REVIEW_ACTIVE_TTL_MS,
  codeReviewLabelProgress,
  codeReviewNeedsAttention,
  codeReviewObservation,
  codeReviewFollowUpText,
  codeReviewStatus,
} from "./code-review.ts";
import type {
  CodeReviewSpec,
  CodeReviewStatus,
} from "./protocol.ts";
import type {
  ForgeConnector,
  PullRequestSpec,
  PullRequestStatus,
} from "../pull-requests/protocol.ts";
import { PULL_REQUEST_RESOURCE_TYPE } from "../pull-requests/resource.ts";
import {
  CODE_REVIEW_RESOURCE_TYPE,
  updateCodeReviewObservation,
} from "./resource.ts";

const REVIEW_ACTION_ACCEPT = "accept";
const REVIEW_ACTION_IGNORE = "ignore";
const CODE_REVIEW_RETRY_INTERVAL_MS = 30_000;

function interactionDecision(
  baton: Readonly<BatonSnapshot>,
  decisionKey: string,
): BatonSnapshot["pluginInteractions"][number] | undefined {
  return baton.pluginInteractions.find(
    (interaction) => interaction.decisionKey === decisionKey,
  );
}

function remainingMs(expiresAt: string, nowMs: number): number {
  const deadline = Date.parse(expiresAt);
  if (!Number.isFinite(deadline)) {
    throw new Error(
      `CodeReview expiresAt must be an ISO timestamp: ${expiresAt}`,
    );
  }
  return Math.max(0, Math.ceil(deadline - nowMs));
}

async function hasBoundPullRequest(
  resources: ResourceClient,
  spec: CodeReviewSpec,
): Promise<boolean> {
  return (await resources.list<PullRequestSpec, PullRequestStatus>(
    PULL_REQUEST_RESOURCE_TYPE,
  )).some(({ spec: { identity } }) =>
    identity.source === spec.pullRequest.source &&
    identity.repository === spec.pullRequest.repository &&
    identity.number === spec.pullRequest.number
  );
}

export function createCodeReviewController(
  resources: ResourceClient,
  connectors: readonly ForgeConnector[] = [],
  sources: readonly Source<CodeReviewSpec>[] = [],
  options: {
    readonly codeReviewTtlMs?: number;
    readonly now?: () => Date;
  } = {},
): Controller<CodeReviewSpec, CodeReviewStatus> {
  const ttlMs = options.codeReviewTtlMs ?? CODE_REVIEW_ACTIVE_TTL_MS;
  const now = options.now ?? (() => new Date());
  const connectorsBySource = new Map<string, ForgeConnector>();
  for (const connector of connectors) {
    if (connectorsBySource.has(connector.source)) {
      throw new Error(`duplicate ForgeConnector source: ${connector.source}`);
    }
    connectorsBySource.set(connector.source, connector);
  }
  return {
    resourceType: CODE_REVIEW_RESOURCE_TYPE,
    ...(sources.length > 0 ? { sources } : {}),
    async reconcile(baton, resource) {
      if (resource.metadata.deletionTimestamp !== undefined) return;

      let current = resource;
      const connector = connectorsBySource.get(
        current.spec.pullRequest.source,
      );
      if (connector?.comments) {
        const observation = codeReviewObservation(
          current.spec,
          await connector.comments(current.spec.pullRequest),
        );
        if (observation) {
          current = await updateCodeReviewObservation(
            resources,
            current,
            observation,
            codeReviewStatus(observation, ttlMs),
          );
        } else if (!current.status.phase) {
          return { requeueAfterMs: CODE_REVIEW_RETRY_INTERVAL_MS };
        }
      } else if (!current.status.phase) {
        return { requeueAfterMs: CODE_REVIEW_RETRY_INTERVAL_MS };
      }

      const nowMs = now().getTime();
      if (!Number.isFinite(nowMs)) {
        throw new Error("CodeReview clock returned an invalid Date");
      }
      const expiresAt = current.status.expiresAt;
      if (!expiresAt) {
        throw new Error(
          `CodeReview/${current.metadata.name} is missing expiresAt`,
        );
      }
      const reviewRemainingMs = remainingMs(expiresAt, nowMs);
      if (reviewRemainingMs === 0) {
        await resources.delete(
          CODE_REVIEW_RESOURCE_TYPE,
          current.metadata.name,
        );
        return;
      }
      const nextRefreshMs = Math.min(
        reviewRemainingMs,
        CODE_REVIEW_RETRY_INTERVAL_MS,
      );

      if (!actionableCodeReview(current.status)) {
        return { requeueAfterMs: nextRefreshMs };
      }
      if (!codeReviewNeedsAttention(current.status) ||
        current.status.decision) {
        return { requeueAfterMs: nextRefreshMs };
      }

      const decisionKey = `handle-review:${current.spec.runKey}`;
      const decision = interactionDecision(baton, decisionKey);
      if (!decision) {
        const identity = current.spec.pullRequest;
        return {
          output: {
            kind: "interaction",
            decisionKey,
            title: "AI review comments found",
            prompt:
              `Ask the current Harness to evaluate the AI review for ` +
              `${identity.repository} PR/MR ${identity.number}?`,
            options: [
              {
                optionId: REVIEW_ACTION_ACCEPT,
                label: "Accept",
                description:
                  "Ask the current Harness to evaluate and fix real findings.",
              },
              {
                optionId: REVIEW_ACTION_IGNORE,
                label: "Ignore",
                role: "reject",
              },
            ],
          },
          requeueAfterMs: nextRefreshMs,
        };
      }
      if (decision.outcome?.kind !== "answered") {
        return { requeueAfterMs: nextRefreshMs };
      }
      const choice = decision.outcome.values[0];
      if (
        choice !== REVIEW_ACTION_ACCEPT &&
        choice !== REVIEW_ACTION_IGNORE
      ) {
        return { requeueAfterMs: nextRefreshMs };
      }

      await resources.patchStatus(current, {
        decision: {
          choice,
          decidedAt: now().toISOString(),
        },
      });
      if (choice !== REVIEW_ACTION_ACCEPT) {
        return { requeueAfterMs: nextRefreshMs };
      }
      return {
        output: {
          kind: "proposed-input",
          text: codeReviewFollowUpText(current.spec, current.status),
        },
        requeueAfterMs: nextRefreshMs,
      };
    },
    async present(resource) {
      if (
        !codeReviewNeedsAttention(resource.status) ||
        resource.metadata.deletionTimestamp
      ) {
        return undefined;
      }
      // A bound review is projected through its PullRequest card so one user
      // action does not consume two Board slots.
      if (await hasBoundPullRequest(resources, resource.spec)) {
        return undefined;
      }
      const identity = resource.spec.pullRequest;
      const failed = resource.status.verdict === "failed";
      const findings = resource.status.result?.findingCount ?? 0;
      const labels = codeReviewLabelProgress(resource.status);
      return {
        title: `${identity.repository} #${identity.number} AI review`,
        status: failed
          ? "Review failed"
          : `${findings} finding${findings === 1 ? "" : "s"}` +
            (labels.total > 0
              ? ` · ${labels.labeled}/${labels.total} labeled`
              : ""),
        ...(resource.status.result?.publicationSummary
          ? { detail: resource.status.result.publicationSummary }
          : {}),
        priority: boardPriority(
          failed ? 200 : 100,
          resource.metadata.creationTimestamp,
        ),
        tone: failed ? "error" : "warning",
      };
    },
  };
}
