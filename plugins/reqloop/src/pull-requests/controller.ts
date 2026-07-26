import type {
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
    async reconcile(_baton, resource) {
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
        !sameIdentity(review.identity, identity) ||
        review.key === current.status.review?.key
      ) {
        return;
      }
      upsertPullRequestReview(resources, review);
      if (actionableReview(review)) {
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
