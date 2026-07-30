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
} from "@compforge/baton-plugin";

import { boardPriority } from "../board.ts";
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

function interactionDecision(
  baton: Readonly<BatonSnapshot>,
  decisionKey: string,
): BatonSnapshot["pluginInteractions"][number] | undefined {
  return baton.pluginInteractions.find(
    (interaction) => interaction.decisionKey === decisionKey,
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
        current.status.mergeability === "conflicted" &&
        !current.status.mergeConflictDecision?.choice
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
        const decision = interactionDecision(
          baton,
          conflictDecision.decisionKey,
        );
        if (!decision) {
          return {
            output: {
              kind: "interaction",
              decisionKey: conflictDecision.decisionKey,
              title: "Merge conflict found",
              prompt:
                `Ask the current Harness to resolve merge conflicts for ` +
                `${identity.repository} PR/MR ${identity.number}?`,
              options: [
                {
                  optionId: MERGE_CONFLICT_ACTION_ACCEPT,
                  label: "Accept",
                  description:
                    "Ask the current Harness to resolve the conflicts.",
                },
                {
                  optionId: MERGE_CONFLICT_ACTION_IGNORE,
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
          choice !== MERGE_CONFLICT_ACTION_ACCEPT &&
          choice !== MERGE_CONFLICT_ACTION_IGNORE
        ) {
          return;
        }
        await resources.patchStatus(current, {
          mergeConflictDecision: {
            decisionKey: conflictDecision.decisionKey,
            choice,
          },
        });
        if (choice === MERGE_CONFLICT_ACTION_ACCEPT) {
          return {
            output: {
              kind: "proposed-input",
              text: mergeConflictFollowUpText(identity, current.status.url),
            },
          };
        }
      }

      if (current.status.lifecycle === "open") {
        const association = current.status.requirementAssociation;
        if (!association || association.state === "prompted") {
          const requirements = await activeRequirements(resources);
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
              current = await resources.patchStatus(current, {
                requirementAssociation: {
                  state: "prompted",
                  decisionKey,
                },
              });
            }
          } else if (decision?.outcome?.kind === "answered") {
            const selected = decision.outcome.values[0];
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
    },
    async present(resource) {
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
        ...(resource.status.url ? { url: resource.status.url } : {}),
        status: blockers.length > 0 ? blockers.join(" · ") : "Open",
        ...(resource.status.title
          ? {
              detail: resource.status.title,
            }
          : {}),
        priority: boardPriority(
          resource.status.mergeability === "conflicted"
            ? 200
            : resource.status.reviewThreads === "unresolved"
            ? 100
            : 0,
          resource.metadata.creationTimestamp,
        ),
        tone: resource.status.mergeability === "conflicted"
          ? "error"
          : resource.status.reviewThreads === "unresolved"
          ? "warning"
          : "default",
      };
    },
  };
}
