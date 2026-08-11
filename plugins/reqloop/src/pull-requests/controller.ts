import type {
  Controller,
  ControllerSource,
  EventHandler,
  EventResource,
  Resource,
  ResourceClient,
  ResourceRef,
  Source,
} from "@compforge/baton-plugin";

import { boardPriority } from "../board.ts";
import {
  codeReviewLabelProgress,
  codeReviewNeedsAttention,
} from "../code-reviews/code-review.ts";
import type {
  CodeReviewSpec,
  CodeReviewStatus,
} from "../code-reviews/protocol.ts";
import { CODE_REVIEW_RESOURCE_TYPE } from "../code-reviews/resource.ts";
import type {
  RequirementSpec,
  RequirementStatus,
} from "../requirements/protocol.ts";
import {
  isRequirementActive,
} from "../requirements/conditions.ts";
import { REQUIREMENT_RESOURCE_TYPE } from "../requirements/resource.ts";
import type {
  ForgeConnector,
  PullRequestIdentity,
  PullRequestSpec,
  PullRequestStatus,
} from "./protocol.ts";
import {
  PULL_REQUEST_RESOURCE_TYPE,
  updatePullRequestObservation,
} from "./resource.ts";

const PULL_REQUEST_POLL_CRON = "*/30 * * * * *";
const PULL_REQUEST_ACTIVE_POLL_INTERVAL_MS = 30_000;
const PULL_REQUEST_IDLE_POLL_INTERVAL_MS = 5 * 60_000;
const MERGE_CONFLICT_ACTION_ACCEPT = "accept";
const MERGE_CONFLICT_ACTION_IGNORE = "ignore";
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

async function activeRequirements(
  resources: ResourceClient,
): Promise<readonly Readonly<Resource<RequirementSpec, RequirementStatus>>[]> {
  return (await resources
    .list<RequirementSpec, RequirementStatus>(REQUIREMENT_RESOURCE_TYPE))
    .filter(({ status }) =>
      status.externalState !== undefined &&
      isRequirementActive(status)
    );
}

function activeRequirement(resource: EventResource): boolean {
  const requirement = resource as Readonly<
    Resource<RequirementSpec, RequirementStatus>
  >;
  return (
    requirement.status.externalState !== undefined &&
    isRequirementActive(requirement.status)
  );
}

async function enqueuePendingAssociationPullRequests(
  resources: ResourceClient,
): Promise<readonly { readonly name: string }[]> {
  return (await resources
    .list<PullRequestSpec, PullRequestStatus>(PULL_REQUEST_RESOURCE_TYPE))
    .filter(({ status }) =>
      status.lifecycle === "open" &&
      (status.requirementAssociation === undefined ||
        status.requirementAssociation.state === "prompted")
    )
    .map(({ metadata }) => ({ name: metadata.name }));
}

function activeRequirementHandler(resources: ResourceClient): EventHandler {
  const handler: EventHandler = {
    async create(event) {
      return activeRequirement(event.object)
        ? await enqueuePendingAssociationPullRequests(resources)
        : [];
    },
    async update(event) {
      return !activeRequirement(event.oldObject) &&
          activeRequirement(event.newObject)
        ? await enqueuePendingAssociationPullRequests(resources)
        : [];
    },
    async delete() {
      return [];
    },
  };
  return Object.freeze(handler);
}

async function codeReviewPullRequest(
  resources: ResourceClient,
  resource: EventResource,
): Promise<readonly { readonly name: string }[]> {
  const codeReview = resource as Readonly<
    Resource<CodeReviewSpec, CodeReviewStatus>
  >;
  const pullRequest = (await resources.list<
    PullRequestSpec,
    PullRequestStatus
  >(PULL_REQUEST_RESOURCE_TYPE)).find(({ spec }) =>
    sameIdentity(spec.identity, codeReview.spec.pullRequest)
  );
  return pullRequest ? [{ name: pullRequest.metadata.name }] : [];
}

function codeReviewHandler(resources: ResourceClient): EventHandler {
  const handler: EventHandler = {
    async create(event) {
      return await codeReviewPullRequest(resources, event.object);
    },
    async update(event) {
      return await codeReviewPullRequest(resources, event.newObject);
    },
    async delete(event) {
      return await codeReviewPullRequest(resources, event.object);
    },
  };
  return Object.freeze(handler);
}

async function pendingCodeReviews(
  resources: ResourceClient,
  identity: PullRequestIdentity,
): Promise<readonly Readonly<Resource<CodeReviewSpec, CodeReviewStatus>>[]> {
  return (await resources.list<CodeReviewSpec, CodeReviewStatus>(
    CODE_REVIEW_RESOURCE_TYPE,
  )).filter((review) =>
    sameIdentity(review.spec.pullRequest, identity) &&
    review.metadata.deletionTimestamp === undefined &&
    codeReviewNeedsAttention(review.status)
  );
}

function codeReviewBoardStatus(
  reviews: readonly Readonly<Resource<CodeReviewSpec, CodeReviewStatus>>[],
): string {
  const progress = reviews.reduce(
    (total, review) => {
      const current = codeReviewLabelProgress(review.status);
      return {
        labeled: total.labeled + current.labeled,
        labelable: total.labelable + current.total,
      };
    },
    { labeled: 0, labelable: 0 },
  );
  const subject = reviews.length === 1
    ? "AI review"
    : `${reviews.length} AI reviews`;
  return progress.labelable > 0
    ? `${subject} · ${progress.labeled}/${progress.labelable} labeled`
    : `${subject} pending`;
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

function associationAsk(
  identity: PullRequestIdentity,
  requirements: readonly Readonly<
    Resource<RequirementSpec, RequirementStatus>
  >[],
  decisionKey: string,
) {
  return {
    key: decisionKey,
    title: "Associate pull request",
    prompt:
      `Which Requirement should ${identity.repository} PR/MR ${identity.number} join?`,
    choices: [
      ...requirements.map((requirement) => ({
        value: requirementOptionId(requirement.metadata.name),
        label: requirement.spec.title,
        description:
          `${requirement.spec.identity.source} · ` +
          `${requirement.spec.identity.category} · ` +
          requirement.spec.identity.id,
      })),
      {
        value: ASSOCIATION_STANDALONE,
        label: "Keep standalone",
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

function observationDue(
  observedAt: string | undefined,
  intervalMs: number,
): boolean {
  if (!observedAt) return true;
  const elapsed = Date.now() - Date.parse(observedAt);
  return !Number.isFinite(elapsed) ||
    elapsed >= intervalMs;
}

function mergeConflictFollowUpText(
  identity: PullRequestIdentity,
  url: string | undefined,
): string {
  const target = `${identity.repository} PR/MR ${identity.number}`;
  return [
    `Resolve the merge conflicts for ${target}${url ? ` (${url})` : ""}.`,
    "",
    "Inspect the target branch changes and every conflicting file. Preserve " +
    "both intended behaviors, run the relevant lint and tests, then update " +
    "the existing PR/MR branch.",
  ].join("\n");
}

export function createPullRequestController(
  resources?: ResourceClient,
  connectors: readonly ForgeConnector[] = [],
  sources: readonly Source<PullRequestSpec>[] = [],
  hasRecentWriteActivity: (
    identity: PullRequestIdentity,
  ) => Promise<boolean> = async () => true,
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
  if (resources && connectors.length > 0) {
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
        }, {
          resourceType: CODE_REVIEW_RESOURCE_TYPE,
          handler: codeReviewHandler(resources),
        }],
      }
      : {}),
    ...(controllerSources.length > 0
      ? { sources: controllerSources }
      : {}),
    async reconcile(context, resource) {
      if (!resources) return;
      let current = resource;
      const legacyAssociation = current.status.requirementAssociation;
      if (
        legacyAssociation?.state === "linked" &&
        legacyAssociation.requirement.uid === undefined
      ) {
        // 0.1.15 persisted name-based refs. Resolve them once during upgrade;
        // every newly written association below is pinned to one incarnation.
        const requirement = (await resources.list<
          RequirementSpec,
          RequirementStatus
        >(
          REQUIREMENT_RESOURCE_TYPE,
        ))
          .find(({ metadata }) =>
            metadata.namespace === legacyAssociation.requirement.namespace &&
            metadata.name === legacyAssociation.requirement.name
          );
        if (requirement) {
          current = await resources.patchStatus(current, {
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
      if (connector) {
        const pollIntervalMs = await hasRecentWriteActivity(identity)
          ? PULL_REQUEST_ACTIVE_POLL_INTERVAL_MS
          : PULL_REQUEST_IDLE_POLL_INTERVAL_MS;
        if (observationDue(current.status.observedAt, pollIntervalMs)) {
          const observation = await connector.get(identity);
          if (!sameIdentity(observation.identity, identity)) {
            throw new Error("ForgeConnector returned a different PullRequest");
          }
          current = await updatePullRequestObservation(resources, observation);
        }
      }
      if (observationComplete(current.status)) return;

      if (
        current.status.mergeability !== "conflicted" &&
        current.status.mergeConflictDecision
      ) {
        // Ending one conflict episode lets a later regression ask again with a
        // new decision key instead of replaying an old user answer.
        current = await resources.patchStatus(current, {
          mergeConflictDecision: null,
        });
      }
      if (
        current.status.lifecycle === "open" &&
        current.status.mergeability === "conflicted"
      ) {
        let conflictDecision = current.status.mergeConflictDecision;
        if (!conflictDecision) {
          const conflictBasis = current.status.observedAt ??
            current.metadata.resourceVersion;
          conflictDecision = {
            decisionKey:
              `handle-merge-conflict:${current.metadata.name}:${conflictBasis}`,
          };
          current = await resources.patchStatus(current, {
            mergeConflictDecision: conflictDecision,
          });
        }
        if (!conflictDecision.choice) {
          const decision = await context.ask({
            key: conflictDecision.decisionKey,
            title: "Merge conflict found",
            prompt:
              `Ask the current Harness to resolve merge conflicts for ` +
              `${identity.repository} PR/MR ${identity.number}?`,
            choices: [
              {
                value: MERGE_CONFLICT_ACTION_ACCEPT,
                label: "Accept",
                description:
                  "Ask the current Harness to resolve the conflicts.",
              },
              {
                value: MERGE_CONFLICT_ACTION_IGNORE,
                label: "Ignore",
              },
            ],
          });
          if (decision.state !== "answered") return;
          current = await resources.patchStatus(current, {
            mergeConflictDecision: {
              decisionKey: conflictDecision.decisionKey,
              choice: decision.value,
            },
          });
          conflictDecision = current.status.mergeConflictDecision;
        }
        if (conflictDecision?.choice === MERGE_CONFLICT_ACTION_ACCEPT) {
          await context.draft({
            key: conflictDecision.decisionKey,
            prompt: mergeConflictFollowUpText(identity, current.status.url),
          });
          return;
        }
      }

      if (current.status.lifecycle === "open") {
        const association = current.status.requirementAssociation;
        if (!association || association.state === "prompted") {
          const requirements = await activeRequirements(resources);
          const decisionKey = association?.decisionKey ??
            `associate-requirement:${current.metadata.name}`;
          const decision = requirements.length > 0
            ? await context.ask(
              associationAsk(identity, requirements, decisionKey),
            )
            : undefined;
          if (decision?.state === "cancelled") {
            if (!association) {
              current = await resources.patchStatus(current, {
                requirementAssociation: {
                  state: "prompted",
                  decisionKey,
                },
              });
            }
          } else if (decision?.state === "answered") {
            const selected = decision.value;
            if (selected === ASSOCIATION_STANDALONE) {
              current = await resources.patchStatus(current, {
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
                  current = await resources.patchStatus(current, {
                    requirementAssociation: {
                      state: "linked",
                      requirement: requirementRef(requirement),
                    },
                  });
                } else if (requirements.length > 0) {
                  const retryDecisionKey =
                    `associate-requirement:${current.metadata.name}:retry:` +
                    current.metadata.resourceVersion;
                  current = await resources.patchStatus(current, {
                    requirementAssociation: {
                      state: "prompted",
                      decisionKey: retryDecisionKey,
                    },
                  });
                  await context.ask(
                    associationAsk(
                      identity,
                      requirements,
                      retryDecisionKey,
                    ),
                  );
                  return;
                }
              }
            }
          }
        }
      }
    },
    async present(resource) {
      const reviews = resources
        ? await pendingCodeReviews(resources, resource.spec.identity)
        : [];
      const hasPendingCodeReview = reviews.length > 0;
      if (
        !hasPendingCodeReview &&
        (resource.status.lifecycle !== "open" ||
          resource.status.requirementAssociation?.state === "linked")
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
        ...(hasPendingCodeReview
          ? [codeReviewBoardStatus(reviews)]
          : []),
      ];
      const lifecycle = resource.status.lifecycle === "open"
        ? undefined
        : resource.status.lifecycle === "merged"
        ? "Merged"
        : "Closed";
      const status = [
        ...(lifecycle ? [lifecycle] : []),
        ...blockers,
      ];
      const conditionPriority =
        resource.status.mergeability === "conflicted"
          ? 200
          : resource.status.reviewThreads === "unresolved"
          ? 100
          : resource.status.lifecycle === "open" && hasPendingCodeReview
          ? 50
          : resource.status.lifecycle === "open"
          ? 0
          // A stale review extends merged PR visibility, but must not displace
          // active delivery blockers when Board capacity is constrained.
          : -100;
      return {
        title:
          `${resource.spec.identity.repository} #` +
          resource.spec.identity.number,
        ...(resource.status.url ? { url: resource.status.url } : {}),
        status: status.length > 0 ? status.join(" · ") : "Open",
        ...(resource.status.title
          ? {
              detail: resource.status.title,
            }
          : {}),
        priority: boardPriority(
          conditionPriority,
          resource.metadata.creationTimestamp,
        ),
        tone: resource.status.mergeability === "conflicted"
          ? "error"
          : resource.status.reviewThreads === "unresolved" ||
              hasPendingCodeReview
          ? "warning"
          : "default",
      };
    },
  };
}
