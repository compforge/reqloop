import type {
  Controller,
  ResourceClient,
  ResourceNamespace,
  Source,
} from "@compforge/baton-plugin";

import { boardPriority } from "../board.ts";
import {
  HARNESS_FOLLOW_UP_TIMEOUT_MS,
  resourceAfterVerb,
  USER_DECISION_TIMEOUT_MS,
  verbFailure,
} from "../reconcile-verb.ts";
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
  namespace: ResourceNamespace,
): Promise<boolean> {
  return (await resources.list<PullRequestSpec, PullRequestStatus>(
    PULL_REQUEST_RESOURCE_TYPE,
    { namespace },
  )).some(({ spec: { identity } }) =>
    identity.forge === spec.pullRequest.forge &&
    identity.path === spec.pullRequest.path &&
    identity.number === spec.pullRequest.number
  );
}

/**
 * @spec A review prompt or draft dismissed by the user degrades to ignore, while one completed Harness follow-up is persisted and never reopened.
 */
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
  const connectorsByForge = new Map<string, ForgeConnector>();
  for (const connector of connectors) {
    if (connectorsByForge.has(connector.forge)) {
      throw new Error(`duplicate ForgeConnector: ${connector.forge}`);
    }
    connectorsByForge.set(connector.forge, connector);
  }
  return {
    resourceType: CODE_REVIEW_RESOURCE_TYPE,
    ...(sources.length > 0 ? { sources } : {}),
    async reconcile(context, resource) {
      if (resource.metadata.deletionTimestamp !== undefined) return;

      let current = resource;
      const connector = connectorsByForge.get(
        current.spec.pullRequest.forge,
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
          current.metadata.namespace as ResourceNamespace,
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
      if (!codeReviewNeedsAttention(current.status)) {
        return { requeueAfterMs: nextRefreshMs };
      }

      if (!current.status.decision) {
        const identity = current.spec.pullRequest;
        const decision = await context.verbs.ask({
          timeoutMs: USER_DECISION_TIMEOUT_MS,
          title: "AI review comments found",
          prompt:
            `Ask the current Harness to evaluate the AI review for ` +
            `${identity.path} PR/MR ${identity.number}?`,
          choices: [
            {
              value: REVIEW_ACTION_ACCEPT,
              label: "Accept",
              description:
                "Ask the current Harness to evaluate and fix real findings.",
            },
            {
              value: REVIEW_ACTION_IGNORE,
              label: "Ignore",
            },
          ],
        });
        if (decision.state === "failure") {
          throw verbFailure("code-review interaction", decision.error);
        }
        const resumed = await resourceAfterVerb(
          resources,
          current,
        );
        if (
          !resumed ||
          !actionableCodeReview(resumed.status) ||
          !codeReviewNeedsAttention(resumed.status)
        ) {
          return { requeueAfterMs: nextRefreshMs };
        }
        current = resumed;
        current = await resources.patchStatus(current, {
          decision: {
            choice: decision.state === "success"
              ? decision.value
              : REVIEW_ACTION_IGNORE,
            decidedAt: now().toISOString(),
          },
        });
      }
      if (current.status.decision?.choice !== REVIEW_ACTION_ACCEPT) {
        return { requeueAfterMs: nextRefreshMs };
      }
      if (!current.status.decision.followUpTurnId) {
        const draft = await context.verbs.draft({
          timeoutMs: HARNESS_FOLLOW_UP_TIMEOUT_MS,
          title: "Handle AI review comments",
          prompt: codeReviewFollowUpText(current.spec, current.status),
        });
        if (draft.state === "failure") {
          throw verbFailure("code-review draft", draft.error);
        }
        const resumed = await resourceAfterVerb(
          resources,
          current,
        );
        if (resumed?.status.decision?.choice !== REVIEW_ACTION_ACCEPT) {
          return { requeueAfterMs: nextRefreshMs };
        }
        const decidedAt = resumed.status.decision.decidedAt;
        current = await resources.patchStatus(resumed, {
          decision: draft.state === "success"
            ? {
              choice: REVIEW_ACTION_ACCEPT,
              decidedAt,
              followUpTurnId: draft.value.turn.turnId,
            }
            : { choice: REVIEW_ACTION_IGNORE, decidedAt },
        });
      }
      return { requeueAfterMs: nextRefreshMs };
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
      if (
        await hasBoundPullRequest(
          resources,
          resource.spec,
          resource.metadata.namespace as ResourceNamespace,
        )
      ) {
        return undefined;
      }
      const identity = resource.spec.pullRequest;
      const failed = resource.status.verdict === "failed";
      const findings = resource.status.result?.findingCount ?? 0;
      const labels = codeReviewLabelProgress(resource.status);
      return {
        title: `${identity.path} #${identity.number} AI review`,
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
