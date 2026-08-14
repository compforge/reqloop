import type {
  Controller,
  Resource,
  ResourceClient,
  ToastSink,
} from "@compforge/baton-plugin";

import { boardPriority } from "../board.ts";
import { enqueueRequestsFromMapFunc } from "../event-handler.ts";
import {
  resourceAfterVerb,
  USER_DECISION_TIMEOUT_MS,
  verbFailure,
} from "../reconcile-verb.ts";
import type {
  PullRequestSpec,
  PullRequestStatus,
} from "../pull-requests/protocol.ts";
import { PULL_REQUEST_RESOURCE_TYPE } from "../pull-requests/resource.ts";
import type {
  Requirement,
  RequirementConnector,
  RequirementIdentity,
  RequirementSpec,
  RequirementStatus,
} from "./protocol.ts";
import {
  REQUIREMENT_RESOURCE_TYPE,
  upsertRequirement,
} from "./resource.ts";
import {
  getStatusCondition,
  isRequirementActive,
  REQUIREMENT_CONDITION,
  setStatusCondition,
  type StatusConditionUpdate,
} from "./conditions.ts";

const REQUIREMENT_POLL_CRON = "0 * * * * *";
const REQUIREMENT_POLL_INTERVAL_MS = 60_000;
const CLOSURE_ACTION_CONFIRM = "confirm";
const CLOSURE_ACTION_KEEP_OPEN = "keep-open";

function sameIdentity(
  left: RequirementIdentity,
  right: RequirementIdentity,
): boolean {
  return (
    left.source === right.source &&
    left.category === right.category &&
    left.id === right.id
  );
}

function observationDue(observedAt: string | undefined): boolean {
  if (!observedAt) return true;
  const elapsed = Date.now() - Date.parse(observedAt);
  return !Number.isFinite(elapsed) ||
    elapsed >= REQUIREMENT_POLL_INTERVAL_MS;
}

// The association is owned by PullRequest status. Mapping old and new snapshots
// keeps both Requirement projections correct if that single owner changes.
const enqueueLinkedRequirement = enqueueRequestsFromMapFunc<
  PullRequestSpec,
  PullRequestStatus
>(async (pullRequest) => {
  const association = pullRequest.status.requirementAssociation;
  if (
    association?.state !== "linked" ||
    association.requirement.apiVersion !==
      REQUIREMENT_RESOURCE_TYPE.apiVersion ||
    association.requirement.kind !== REQUIREMENT_RESOURCE_TYPE.kind ||
    association.requirement.namespace !== pullRequest.metadata.namespace
  ) {
    return [];
  }
  return [{ name: association.requirement.name }];
});

async function linkedPullRequests(
  resources: ResourceClient,
  requirement: Readonly<Resource<RequirementSpec, RequirementStatus>>,
): Promise<readonly Readonly<Resource<PullRequestSpec, PullRequestStatus>>[]> {
  return (await resources.list<PullRequestSpec, PullRequestStatus>(
    PULL_REQUEST_RESOURCE_TYPE,
  ))
    .filter(({ status }) =>
      status.requirementAssociation?.state === "linked" &&
      status.requirementAssociation.requirement.apiVersion ===
        REQUIREMENT_RESOURCE_TYPE.apiVersion &&
      status.requirementAssociation.requirement.kind ===
        REQUIREMENT_RESOURCE_TYPE.kind &&
      status.requirementAssociation.requirement.namespace ===
        requirement.metadata.namespace &&
      status.requirementAssociation.requirement.name ===
        requirement.metadata.name &&
      status.requirementAssociation.requirement.uid ===
        requirement.metadata.uid &&
      status.lifecycle !== "closed"
    );
}

function summarizePullRequests(
  pullRequests: readonly Readonly<
    Resource<PullRequestSpec, PullRequestStatus>
  >[],
): NonNullable<RequirementStatus["linkedPullRequests"]> {
  return {
    total: pullRequests.length,
    open: pullRequests.filter(({ status }) => status.lifecycle === "open")
      .length,
    merged: pullRequests.filter(({ status }) => status.lifecycle === "merged")
      .length,
    conflicted: pullRequests.filter(({ status }) =>
      status.mergeability === "conflicted"
    ).length,
    unresolvedReviewThreads: pullRequests.filter(({ status }) =>
      status.reviewThreads === "unresolved"
    ).length,
  };
}

function readyToCloseCondition(
  pullRequests: readonly Readonly<
    Resource<PullRequestSpec, PullRequestStatus>
  >[],
  observedGeneration: number,
): StatusConditionUpdate {
  const base = {
    type: REQUIREMENT_CONDITION.readyToClose,
    observedGeneration,
  } as const;
  if (pullRequests.length === 0) {
    return {
      ...base,
      status: "False",
      reason: "NoLinkedPullRequests",
      message: "No active PullRequests are linked to this Requirement.",
    };
  }
  if (pullRequests.some(({ status }) => status.mergeability === "conflicted")) {
    return {
      ...base,
      status: "False",
      reason: "MergeConflicts",
      message: "At least one linked PullRequest has merge conflicts.",
    };
  }
  if (pullRequests.some(({ status }) => status.lifecycle !== "merged")) {
    return {
      ...base,
      status: "False",
      reason: "PullRequestsNotMerged",
      message: "At least one linked PullRequest is not merged.",
    };
  }
  if (pullRequests.some(({ status }) => status.reviewThreads === "unresolved")) {
    return {
      ...base,
      status: "False",
      reason: "UnresolvedReviewThreads",
      message: "At least one linked PullRequest has unresolved review threads.",
    };
  }
  if (
    pullRequests.some(({ status }) =>
      status.reviewThreads === undefined ||
      status.reviewThreads === "unknown"
    )
  ) {
    return {
      ...base,
      status: "Unknown",
      reason: "ReviewStatusUnknown",
      message: "Review-thread status is unavailable for a linked PullRequest.",
    };
  }
  return {
    ...base,
    status: "True",
    reason: "PullRequestsSettled",
    message: "All linked PullRequests are merged with no unresolved reviews.",
  };
}

function closureDecisionBasis(
  requirementGeneration: number,
  pullRequests: readonly Readonly<
    Resource<PullRequestSpec, PullRequestStatus>
  >[],
): string {
  const pullRequestBasis = pullRequests
    .map(({ metadata }) =>
      `${metadata.name}@${metadata.resourceVersion}`
    )
    .sort()
    .join(",");
  return `${requirementGeneration}:${pullRequestBasis}`;
}

/**
 * @spec A ready-to-close answer is valid only for the PullRequest revision basis observed when it was requested; dismiss and timeout defer that basis without repeated prompts.
 */
export function createRequirementController(
  resources?: ResourceClient,
  connectors: readonly RequirementConnector[] = [],
  toast?: ToastSink,
): Controller<RequirementSpec, RequirementStatus> {
  const connectorsBySource = new Map<string, RequirementConnector>();
  for (const connector of connectors) {
    if (connectorsBySource.has(connector.source)) {
      throw new Error(
        `duplicate RequirementConnector source: ${connector.source}`,
      );
    }
    connectorsBySource.set(connector.source, connector);
  }

  return {
    resourceType: REQUIREMENT_RESOURCE_TYPE,
    watches: [{
      resourceType: PULL_REQUEST_RESOURCE_TYPE,
      handler: enqueueLinkedRequirement,
    }],
    maxConcurrency: 2,
    ...(resources && connectors.length > 0
      ? {
        sources: [{
          type: "cron" as const,
          sourceId: "requirement-poll",
          cron: REQUIREMENT_POLL_CRON,
          timeZone: "UTC",
        }],
      }
      : {}),
    async reconcile(context, resource) {
      if (!resources) return;
      let current = resource;
      const connector = connectorsBySource.get(
        resource.spec.identity.source,
      );
      let observationError: unknown;
      if (connector && observationDue(current.status.lastObservedAt)) {
        try {
          const observation: Requirement = await connector.get(
            resource.spec.identity,
          );
          if (!sameIdentity(observation, resource.spec.identity)) {
            throw new Error(
              "RequirementConnector returned a different Requirement",
            );
          }
          current = await upsertRequirement(resources, observation);
          current = await resources.patchStatus(current, {
            lastObservedAt: new Date().toISOString(),
          });
        } catch (error) {
          current = await resources.patchStatus(current, {
            conditions: setStatusCondition(current.status.conditions, {
              type: REQUIREMENT_CONDITION.observed,
              status: "False",
              observedGeneration: current.metadata.generation,
              reason: "ObservationFailed",
              message:
                `Requirement observation from ${resource.spec.identity.source} failed.`,
            }),
          });
          observationError = error;
        }
      }
      if (!isRequirementActive(current.status)) {
        if (observationError) throw observationError;
        return;
      }

      const pullRequests = await linkedPullRequests(
        resources,
        current,
      );
      const readyToClose = readyToCloseCondition(
        pullRequests,
        current.metadata.generation,
      );
      current = await resources.patchStatus(current, {
        linkedPullRequests: summarizePullRequests(pullRequests),
        conditions: setStatusCondition(
          current.status.conditions,
          readyToClose,
        ),
      });
      if (readyToClose.status === "True") {
        const decisionBasis = closureDecisionBasis(
          current.metadata.generation,
          pullRequests,
        );
        let choice = current.status.closureDecision?.basis === decisionBasis
          ? current.status.closureDecision.choice
          : undefined;
        if (!choice) {
          const decision = await context.verbs.ask({
            timeoutMs: USER_DECISION_TIMEOUT_MS,
            title: "Close requirement",
            prompt:
              `Requirement "${current.spec.title}" looks ready to close. ` +
              "Stop tracking it in reqloop?",
            choices: [
              {
                value: CLOSURE_ACTION_CONFIRM,
                label: "Close in reqloop",
                description:
                  "Hide it locally without changing the external requirement.",
              },
              {
                value: CLOSURE_ACTION_KEEP_OPEN,
                label: "Keep open",
              },
            ],
          });
          if (decision.state === "failure") {
            throw verbFailure("close Requirement interaction", decision.error);
          }
          choice = decision.state === "success"
            ? decision.value
            : CLOSURE_ACTION_KEEP_OPEN;

          const resumed = await resourceAfterVerb(
            resources,
            current,
          );
          if (!resumed || !isRequirementActive(resumed.status)) return;
          current = resumed;
          const latestPullRequests = await linkedPullRequests(
            resources,
            current,
          );
          const latestReadyToClose = readyToCloseCondition(
            latestPullRequests,
            current.metadata.generation,
          );
          if (
            latestReadyToClose.status !== "True" ||
            closureDecisionBasis(
              current.metadata.generation,
              latestPullRequests,
            ) !== decisionBasis
          ) {
            if (observationError) throw observationError;
            return;
          }
          current = await resources.patchStatus(current, {
            closureDecision: { basis: decisionBasis, choice },
          });
        }
        if (choice !== CLOSURE_ACTION_CONFIRM) {
          if (observationError) throw observationError;
          return;
        }
        current = await resources.patchStatus(current, {
          conditions: setStatusCondition(current.status.conditions, {
            type: REQUIREMENT_CONDITION.closureRequested,
            status: "True",
            observedGeneration: current.metadata.generation,
            reason: "UserConfirmed",
            message:
              "The user asked reqloop to stop tracking this Requirement.",
          }),
        });
        toast?.show({
          text:
            `Requirement "${current.spec.title}" was closed in reqloop. ` +
            "The external requirement was not changed.",
          tone: "success",
        });
      } else if (current.status.closureDecision) {
        current = await resources.patchStatus(current, {
          closureDecision: null,
        });
      }
      if (observationError) throw observationError;
    },
    async present(resource) {
      if (!isRequirementActive(resource.status)) return undefined;
      const state = resource.status.externalState;
      const pullRequests = resource.status.linkedPullRequests;
      const readyToClose = getStatusCondition(
        resource.status.conditions,
        REQUIREMENT_CONDITION.readyToClose,
      );
      const pullRequestStatus = pullRequests && pullRequests.total > 0
        ? [
          ...(pullRequests.open > 0
            ? [`${pullRequests.open} PR open`]
            : []),
          ...(pullRequests.merged > 0
            ? [`${pullRequests.merged} PR merged`]
            : []),
          ...(pullRequests.open === 0 && pullRequests.merged === 0
            ? [`${pullRequests.total} PR linked`]
            : []),
          ...(pullRequests.conflicted > 0
            ? [`${pullRequests.conflicted} merge conflict`]
            : []),
          ...(pullRequests.unresolvedReviewThreads > 0
            ? [
              `${pullRequests.unresolvedReviewThreads} unresolved review`,
            ]
            : []),
          ...(readyToClose?.status === "True"
            ? ["Ready to close"]
            : []),
        ]
        : [];
      return {
        title: resource.spec.identity.id,
        ...(resource.status.url ? { url: resource.status.url } : {}),
        status: [state ?? "Not observed", ...pullRequestStatus].join(" · "),
        detail: resource.spec.title,
        priority: boardPriority(
          pullRequests?.conflicted
            ? 200
            : pullRequests?.unresolvedReviewThreads
            ? 100
            : 0,
          resource.metadata.creationTimestamp,
        ),
        tone: pullRequests?.conflicted
          ? "error"
          : pullRequests?.unresolvedReviewThreads
          ? "warning"
          : state === "unknown"
          ? "muted"
          : "default",
      };
    },
  };
}
