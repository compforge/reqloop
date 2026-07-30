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
  codeReviewObservation,
  codeReviewFollowUpText,
  codeReviewStatus,
} from "./code-review.ts";
import type {
  EvaluationSpec,
  EvaluationStatus,
} from "./protocol.ts";
import type { ForgeConnector } from "../pull-requests/protocol.ts";
import {
  EVALUATION_RESOURCE_TYPE,
  updateEvaluationObservation,
} from "./resource.ts";

const REVIEW_ACTION_ACCEPT = "accept";
const REVIEW_ACTION_IGNORE = "ignore";
const EVALUATION_RETRY_INTERVAL_MS = 30_000;

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
      `Evaluation expiresAt must be an ISO timestamp: ${expiresAt}`,
    );
  }
  return Math.max(0, Math.ceil(deadline - nowMs));
}

export function createEvaluationController(
  resources: ResourceClient,
  connectors: readonly ForgeConnector[] = [],
  sources: readonly Source<EvaluationSpec>[] = [],
  options: {
    readonly codeReviewTtlMs?: number;
    readonly now?: () => Date;
  } = {},
): Controller<EvaluationSpec, EvaluationStatus> {
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
    resourceType: EVALUATION_RESOURCE_TYPE,
    ...(sources.length > 0 ? { sources } : {}),
    async reconcile(baton, resource) {
      if (resource.metadata.deletionTimestamp !== undefined) return;

      let current = resource;
      if (!current.status.phase) {
        const connector = connectorsBySource.get(
          current.spec.target.identity.source,
        );
        if (!connector?.comments) {
          return { requeueAfterMs: EVALUATION_RETRY_INTERVAL_MS };
        }
        const observation = codeReviewObservation(
          current.spec,
          await connector.comments(current.spec.target.identity),
        );
        if (!observation) {
          return { requeueAfterMs: EVALUATION_RETRY_INTERVAL_MS };
        }
        current = await updateEvaluationObservation(
          resources,
          current,
          observation,
          codeReviewStatus(observation, ttlMs),
        );
      }

      const nowMs = now().getTime();
      if (!Number.isFinite(nowMs)) {
        throw new Error("Evaluation clock returned an invalid Date");
      }
      const expiresAt = current.status.expiresAt;
      if (!expiresAt) {
        throw new Error(
          `Evaluation/${current.metadata.name} is missing expiresAt`,
        );
      }
      const evaluationRemainingMs = remainingMs(expiresAt, nowMs);
      if (evaluationRemainingMs === 0) {
        await resources.delete(
          EVALUATION_RESOURCE_TYPE,
          current.metadata.name,
        );
        return;
      }

      if (!actionableCodeReview(current.status)) {
        return { requeueAfterMs: evaluationRemainingMs };
      }
      if (current.status.decision) {
        return { requeueAfterMs: evaluationRemainingMs };
      }

      const decisionKey = `handle-review:${current.spec.runKey}`;
      const decision = interactionDecision(baton, decisionKey);
      if (!decision) {
        const identity = current.spec.target.identity;
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
          requeueAfterMs: evaluationRemainingMs,
        };
      }
      if (decision.outcome?.kind !== "answered") {
        return { requeueAfterMs: evaluationRemainingMs };
      }
      const choice = decision.outcome.values[0];
      if (
        choice !== REVIEW_ACTION_ACCEPT &&
        choice !== REVIEW_ACTION_IGNORE
      ) {
        return { requeueAfterMs: evaluationRemainingMs };
      }

      await resources.patchStatus(current, {
        decision: {
          choice,
          decidedAt: now().toISOString(),
        },
      });
      if (choice !== REVIEW_ACTION_ACCEPT) {
        return { requeueAfterMs: evaluationRemainingMs };
      }
      return {
        output: {
          kind: "proposed-input",
          text: codeReviewFollowUpText(current.spec, current.status),
        },
        requeueAfterMs: evaluationRemainingMs,
      };
    },
    async present(resource) {
      if (
        !actionableCodeReview(resource.status) ||
        resource.status.decision ||
        resource.metadata.deletionTimestamp
      ) {
        return undefined;
      }
      const identity = resource.spec.target.identity;
      const failed = resource.status.verdict === "failed";
      const findings = resource.status.result?.findingCount ?? 0;
      return {
        title: `${identity.repository} #${identity.number} AI review`,
        status: failed
          ? "Review failed"
          : `${findings} finding${findings === 1 ? "" : "s"}`,
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
