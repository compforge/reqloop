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
import { REQUIREMENT_RESOURCE_KIND } from "../requirements/resource.ts";
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
    .list<RequirementSpec, RequirementStatus>(REQUIREMENT_RESOURCE_KIND)
    .filter(({ status }) =>
      status.externalState !== "completed" &&
      status.externalState !== "closed"
    );
}

function requirementOptionId(resourceId: string): string {
  return `${ASSOCIATION_REQUIREMENT_PREFIX}${resourceId}`;
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
      // A merged PR/MR is terminal for reqloop. Keeping the persisted Resource
      // preserves history without continuing external polling.
      if (resource.status.lifecycle === "merged") return;
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
      if (current.status.lifecycle === "merged") return;

      const association = current.status.requirementAssociation;
      if (!association) {
        const requirements = activeRequirements(resources);
        if (requirements.length > 0) {
          const decisionKey =
            `associate-requirement:${current.metadata.resourceId}`;
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
                    requirement.metadata.resourceId,
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
            const resourceId = selected.slice(
              ASSOCIATION_REQUIREMENT_PREFIX.length,
            );
            if (resourceId) {
              current = resources.patchStatus(current, {
                requirementAssociation: {
                  state: "linked",
                  requirement: {
                    resourceKind: REQUIREMENT_RESOURCE_KIND,
                    resourceId,
                    resourceOwner: "plugin",
                  },
                },
              });
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

      const decisionKey = `inspect-review:${review.key}`;
      const decision = interactionDecision(baton, decisionKey);
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
