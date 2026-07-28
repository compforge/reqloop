import type {
  BatonSnapshot,
  Controller,
  Resource,
  ResourceClient,
} from "@qiankun01/baton-plugin";

import type {
  RequirementSpec,
  RequirementStatus,
} from "../requirements/protocol.ts";
import { REQUIREMENT_RESOURCE_TYPE } from "../requirements/resource.ts";
import type {
  ForgeConnector,
  PullRequestIdentity,
  PullRequestReviewConnector,
  PullRequestSpec,
  PullRequestStatus,
} from "./protocol.ts";
import {
  PULL_REQUEST_RESOURCE_TYPE,
  upsertPullRequest,
  upsertPullRequestReview,
} from "./resource.ts";
import {
  actionableReview,
  reviewFollowUpText,
} from "./review.ts";

const PULL_REQUEST_POLL_CRON = "*/30 * * * * *";
const PULL_REQUEST_POLL_INTERVAL_MS = 30_000;
const REVIEW_ACTION_ACCEPT = "accept";
const REVIEW_ACTION_IGNORE = "ignore";
const ASSOCIATION_STANDALONE = "standalone";
const ASSOCIATION_REQUIREMENT_PREFIX = "requirement:";

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

function interactionDecision(
  baton: Readonly<BatonSnapshot>,
  decisionKey: string,
): BatonSnapshot["pluginInteractions"][number] | undefined {
  return baton.pluginInteractions.find(
    (interaction) => interaction.decisionKey === decisionKey,
  );
}

function activeRequirements(
  resources: ResourceClient,
): readonly Readonly<Resource<RequirementSpec, RequirementStatus>>[] {
  return resources
    .list<RequirementSpec, RequirementStatus>(REQUIREMENT_RESOURCE_TYPE)
    .filter(({ status }) =>
      status.externalState !== "completed" &&
      status.externalState !== "closed"
    );
}

function requirementOptionId(name: string): string {
  return `${ASSOCIATION_REQUIREMENT_PREFIX}${name}`;
}

function observationComplete(
  status: PullRequestStatus,
): boolean {
  return status.lifecycle === "closed" ||
    (status.lifecycle === "merged" &&
      (status.reviewThreads === "none" ||
        status.reviewThreads === "resolved"));
}

function observationDue(observedAt: string | undefined): boolean {
  if (!observedAt) return true;
  const elapsed = Date.now() - Date.parse(observedAt);
  return !Number.isFinite(elapsed) ||
    elapsed >= PULL_REQUEST_POLL_INTERVAL_MS;
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
    resourceType: PULL_REQUEST_RESOURCE_TYPE,
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
      // Merged PRs remain observable until review state can satisfy the
      // Requirement completion policy. Closed and settled merged PRs are final.
      if (observationComplete(resource.status)) return;
      const { identity } = resource.spec;
      const connector = connectorsBySource.get(identity.source);
      let current = resource;
      if (connector && observationDue(resource.status.observedAt)) {
        const observation = await connector.get(identity);
        if (!sameIdentity(observation.identity, identity)) {
          throw new Error("ForgeConnector returned a different PullRequest");
        }
        current = upsertPullRequest(resources, observation);
      }
      if (
        current.status.lifecycle === "merged" ||
        current.status.lifecycle === "closed"
      ) {
        return;
      }

      if (current.status.lifecycle === "open") {
        const association = current.status.requirementAssociation;
        if (!association) {
          const requirements = activeRequirements(resources);
          if (requirements.length > 0) {
            const decisionKey =
              `associate-requirement:${current.metadata.name}`;
            current = resources.patchStatus(current, {
              requirementAssociation: {
                state: "prompted",
                decisionKey,
              },
            });
            return {
              output: {
                kind: "interaction",
                decisionKey,
                title: "Associate pull request",
                prompt: `Which Requirement should ${identity.repository} PR/MR ${identity.number} join?`,
                options: [
                  ...requirements.map((requirement) => ({
                    optionId: requirementOptionId(
                      requirement.metadata.name,
                    ),
                    label: requirement.spec.title,
                    description:
                      `${requirement.spec.identity.source} · ` +
                      `${requirement.spec.identity.category} · ` +
                      requirement.spec.identity.id,
                  })),
                  {
                    optionId: ASSOCIATION_STANDALONE,
                    label: "Keep standalone",
                    role: "reject" as const,
                  },
                ],
              },
            };
          }
        } else if (association.state === "prompted") {
          const decision = interactionDecision(
            baton,
            association.decisionKey,
          );
          if (decision?.outcome?.kind === "answered") {
            const selected = decision.outcome.values[0];
            if (selected === ASSOCIATION_STANDALONE) {
              current = resources.patchStatus(current, {
                requirementAssociation: { state: "standalone" },
              });
            } else if (selected?.startsWith(ASSOCIATION_REQUIREMENT_PREFIX)) {
              const name = selected.slice(
                ASSOCIATION_REQUIREMENT_PREFIX.length,
              );
              if (name) {
                current = resources.patchStatus(current, {
                  requirementAssociation: {
                    state: "linked",
                    requirement: {
                      ...REQUIREMENT_RESOURCE_TYPE,
                      namespace: current.metadata.namespace,
                      name,
                    },
                  },
                });
              }
            }
          }
        }
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
      if (current.status.reviewDecision?.reviewKey === review.key) return;

      const decisionKey = `handle-review:${review.key}`;
      const decision = interactionDecision(baton, decisionKey);
      if (!decision) {
        return {
          output: {
            kind: "interaction",
            decisionKey,
            title: "Review comments found",
            prompt: `Ask the current Harness to evaluate and fix the review comments for ${identity.repository} PR/MR ${identity.number}?`,
            options: [
              {
                optionId: REVIEW_ACTION_ACCEPT,
                label: "Accept",
                description: "Ask the current Harness to evaluate and fix them.",
              },
              {
                optionId: REVIEW_ACTION_IGNORE,
                label: "Ignore",
                role: "reject",
              },
            ],
          },
        };
      }
      if (decision.outcome?.kind !== "answered") return;
      const choice = decision.outcome.values[0];
      if (
        choice !== REVIEW_ACTION_ACCEPT &&
        choice !== REVIEW_ACTION_IGNORE
      ) {
        return;
      }
      resources.patchStatus(current, {
        reviewDecision: {
          reviewKey: review.key,
          choice,
        },
      });
      if (choice === REVIEW_ACTION_ACCEPT) {
        return {
          output: {
            kind: "proposed-input",
            text: reviewFollowUpText(review),
          },
        };
      }
    },
    present(resource) {
      if (
        resource.status.lifecycle !== "open" ||
        resource.status.requirementAssociation?.state === "linked"
      ) {
        return undefined;
      }
      const blockers = [
        ...(resource.status.mergeability === "conflicted"
          ? ["Merge conflict"]
          : []),
        ...(resource.status.reviewThreads === "unresolved"
          ? ["Unresolved review threads"]
          : []),
      ];
      return {
        title:
          `${resource.spec.identity.repository} #` +
          resource.spec.identity.number,
        status: blockers.length > 0 ? blockers.join(" · ") : "Open",
        detail: resource.status.requirementAssociation?.state === "prompted"
          ? "Waiting for Requirement association"
          : "Standalone PullRequest",
        tone: resource.status.mergeability === "conflicted"
          ? "error"
          : resource.status.reviewThreads === "unresolved"
          ? "warning"
          : "default",
      };
    },
  };
}
