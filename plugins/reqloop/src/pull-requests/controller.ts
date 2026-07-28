import type {
  BatonSnapshot,
  Controller,
  ControllerSource,
  EventHandler,
  EventResource,
  Resource,
  ResourceClient,
  ResourceRef,
  Source,
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
      status.externalState !== undefined &&
      status.externalState !== "completed" &&
      status.externalState !== "closed"
    );
}

function activeRequirement(resource: EventResource): boolean {
  const requirement = resource as Readonly<
    Resource<RequirementSpec, RequirementStatus>
  >;
  return (
    requirement.status.externalState !== undefined &&
    requirement.status.externalState !== "completed" &&
    requirement.status.externalState !== "closed"
  );
}

function enqueuePendingAssociationPullRequests(
  resources: ResourceClient,
): readonly { readonly name: string }[] {
  return resources
    .list<PullRequestSpec, PullRequestStatus>(PULL_REQUEST_RESOURCE_TYPE)
    .filter(({ status }) =>
      status.lifecycle === "open" &&
      (status.requirementAssociation === undefined ||
        status.requirementAssociation.state === "prompted")
    )
    .map(({ metadata }) => ({ name: metadata.name }));
}

function activeRequirementHandler(resources: ResourceClient): EventHandler {
  const handler: EventHandler = {
    create(event) {
      return activeRequirement(event.object)
        ? enqueuePendingAssociationPullRequests(resources)
        : [];
    },
    update(event) {
      return !activeRequirement(event.oldObject) &&
          activeRequirement(event.newObject)
        ? enqueuePendingAssociationPullRequests(resources)
        : [];
    },
    delete() {
      return [];
    },
  };
  return Object.freeze(handler);
}

function requirementOptionId(name: string): string {
  return `${ASSOCIATION_REQUIREMENT_PREFIX}${name}`;
}

function requirementRef(
  requirement: Readonly<Resource<RequirementSpec, RequirementStatus>>,
): ResourceRef {
  return {
    ...REQUIREMENT_RESOURCE_TYPE,
    namespace: requirement.metadata.namespace,
    name: requirement.metadata.name,
    uid: requirement.metadata.uid,
  };
}

function associationInteraction(
  identity: PullRequestIdentity,
  requirements: readonly Readonly<
    Resource<RequirementSpec, RequirementStatus>
  >[],
  decisionKey: string,
) {
  return {
    kind: "interaction" as const,
    decisionKey,
    title: "Associate pull request",
    prompt:
      `Which Requirement should ${identity.repository} PR/MR ${identity.number} join?`,
    options: [
      ...requirements.map((requirement) => ({
        optionId: requirementOptionId(requirement.metadata.name),
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
  };
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
  sources: readonly Source<PullRequestSpec>[] = [],
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
  const controllerSources: ControllerSource<PullRequestSpec>[] = [
    ...sources,
  ];
  if (resources && (connectors.length > 0 || reviewConnector)) {
    controllerSources.push({
      type: "cron",
      sourceId: "pull-request-poll",
      cron: PULL_REQUEST_POLL_CRON,
      timeZone: "UTC",
    });
  }
  return {
    resourceType: PULL_REQUEST_RESOURCE_TYPE,
    ...(resources
      ? {
        watches: [{
          resourceType: REQUIREMENT_RESOURCE_TYPE,
          handler: activeRequirementHandler(resources),
        }],
      }
      : {}),
    ...(controllerSources.length > 0
      ? { sources: controllerSources }
      : {}),
    async reconcile(baton, resource) {
      if (!resources) return;
      let current = resource;
      const legacyAssociation = current.status.requirementAssociation;
      if (
        legacyAssociation?.state === "linked" &&
        legacyAssociation.requirement.uid === undefined
      ) {
        // 0.1.15 persisted name-based refs. Resolve them once during upgrade;
        // every newly written association below is pinned to one incarnation.
        const requirement = resources
          .list<RequirementSpec, RequirementStatus>(
            REQUIREMENT_RESOURCE_TYPE,
          )
          .find(({ metadata }) =>
            metadata.namespace === legacyAssociation.requirement.namespace &&
            metadata.name === legacyAssociation.requirement.name
          );
        if (requirement) {
          current = resources.patchStatus(current, {
            requirementAssociation: {
              state: "linked",
              requirement: requirementRef(requirement),
            },
          });
        }
      }
      // Merged PRs remain observable until review state can satisfy the
      // Requirement completion policy. Closed and settled merged PRs are final.
      if (observationComplete(current.status)) return;
      const { identity } = current.spec;
      const connector = connectorsBySource.get(identity.source);
      if (connector && observationDue(current.status.observedAt)) {
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
        if (!association || association.state === "prompted") {
          const requirements = activeRequirements(resources);
          const decisionKey = association?.decisionKey ??
            `associate-requirement:${current.metadata.name}`;
          const decision = interactionDecision(baton, decisionKey);
          if (!decision && requirements.length > 0) {
            return {
              output: associationInteraction(
                identity,
                requirements,
                decisionKey,
              ),
            };
          } else if (decision?.outcome?.kind === "cancelled") {
            if (!association) {
              current = resources.patchStatus(current, {
                requirementAssociation: {
                  state: "prompted",
                  decisionKey,
                },
              });
            }
          } else if (decision?.outcome?.kind === "answered") {
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
                const requirement = requirements.find(({ metadata }) =>
                  metadata.namespace === current.metadata.namespace &&
                  metadata.name === name
                );
                if (requirement) {
                  current = resources.patchStatus(current, {
                    requirementAssociation: {
                      state: "linked",
                      requirement: requirementRef(requirement),
                    },
                  });
                } else if (requirements.length > 0) {
                  const retryDecisionKey =
                    `associate-requirement:${current.metadata.name}:retry:` +
                    current.metadata.resourceVersion;
                  current = resources.patchStatus(current, {
                    requirementAssociation: {
                      state: "prompted",
                      decisionKey: retryDecisionKey,
                    },
                  });
                  return {
                    output: associationInteraction(
                      identity,
                      requirements,
                      retryDecisionKey,
                    ),
                  };
                }
              }
            }
          }
        }
      }

      const review = reviewConnector?.latest(identity);
      if (!review) return;
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
          : resource.status.requirementAssociation?.state === "standalone"
          ? "Standalone PullRequest"
          : "Unassociated PullRequest",
        tone: resource.status.mergeability === "conflicted"
          ? "error"
          : resource.status.reviewThreads === "unresolved"
          ? "warning"
          : "default",
      };
    },
  };
}
