import type {
  BatonSnapshot,
  Controller,
  ResourceClient,
} from "@qiankun01/baton-plugin";

import type {
  ForgeConnector,
  PullRequestIdentity,
  PullRequestReviewConnector,
  PullRequestSpec,
  PullRequestStatus,
} from "./protocol.ts";
import {
  PULL_REQUEST_RESOURCE_KIND,
  upsertPullRequestObservation,
  upsertPullRequestReview,
} from "./resource.ts";
import {
  actionableReview,
  reviewFollowUpText,
} from "./review.ts";

const PULL_REQUEST_POLL_CRON = "*/30 * * * * *";
const REVIEW_ACTION_INSPECT = "inspect";
const REVIEW_ACTION_SKIP = "skip";

function sameIdentity(
  left: PullRequestIdentity,
  right: PullRequestIdentity,
): boolean {
  return (
    left.source === right.source &&
    left.repository === right.repository &&
    left.number === right.number
  );
}

function reviewDecision(
  baton: Readonly<BatonSnapshot>,
  decisionKey: string,
): BatonSnapshot["pluginInteractions"][number] | undefined {
  return baton.pluginInteractions.find(
    (interaction) => interaction.decisionKey === decisionKey,
  );
}

export function createPullRequestController(
  resources?: ResourceClient,
  connectors: readonly ForgeConnector[] = [],
  reviewConnector?: PullRequestReviewConnector,
): Controller<
  PullRequestSpec,
  PullRequestStatus
> {
  const connectorsBySource = new Map<string, ForgeConnector>();
  for (const connector of connectors) {
    if (connectorsBySource.has(connector.source)) {
      throw new Error(`duplicate ForgeConnector source: ${connector.source}`);
    }
    connectorsBySource.set(connector.source, connector);
  }

  return {
    resourceKind: PULL_REQUEST_RESOURCE_KIND,
    ...(resources && (connectors.length > 0 || reviewConnector)
      ? {
        sources: [{
          type: "cron" as const,
          sourceId: "pull-request-poll",
          cron: PULL_REQUEST_POLL_CRON,
          timeZone: "UTC",
        }],
      }
      : {}),
    async reconcile(baton, resource) {
      if (!resources) return;
      const { identity } = resource.spec;
      const connector = connectorsBySource.get(identity.source);
      let current = resource;
      if (connector) {
        const observation = await connector.get(identity);
        if (!sameIdentity(observation.identity, identity)) {
          throw new Error("ForgeConnector returned a different PullRequest");
        }
        current = upsertPullRequestObservation(resources, observation);
      }

      const review = reviewConnector?.latest();
      if (
        !review ||
        !sameIdentity(review.identity, identity)
      ) {
        return;
      }
      if (review.key !== current.status.review?.key) {
        current = upsertPullRequestReview(resources, review);
      }
      if (!actionableReview(review)) return;

      const decisionKey = `inspect-review:${review.key}`;
      const decision = reviewDecision(baton, decisionKey);
      if (!decision) {
        return {
          output: {
            kind: "interaction",
            decisionKey,
            title: "Review completed",
            prompt: `devloop found actionable results for ${identity.repository} PR/MR ${identity.number}. Inspect them with the current Harness now?`,
            options: [
              {
                optionId: REVIEW_ACTION_INSPECT,
                label: "Inspect review",
              },
              {
                optionId: REVIEW_ACTION_SKIP,
                label: "Not now",
                role: "reject",
              },
            ],
          },
        };
      }
      if (
        decision.outcome?.kind === "answered" &&
        decision.outcome.values.includes(REVIEW_ACTION_INSPECT)
      ) {
        return {
          output: {
            kind: "proposed-input",
            text: reviewFollowUpText(review),
          },
        };
      }
    },
  };
}
