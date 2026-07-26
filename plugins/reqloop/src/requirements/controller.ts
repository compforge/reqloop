import type {
  Controller,
  Resource,
  ResourceClient,
  ToastSink,
} from "@qiankun01/baton-plugin";

import type {
  PullRequestSpec,
  PullRequestStatus,
} from "../pull-requests/protocol.ts";
import { PULL_REQUEST_RESOURCE_KIND } from "../pull-requests/resource.ts";
import type {
  Requirement,
  RequirementConnector,
  RequirementIdentity,
  RequirementSpec,
  RequirementStatus,
} from "./protocol.ts";
import {
  REQUIREMENT_RESOURCE_KIND,
  upsertRequirement,
} from "./resource.ts";

const REQUIREMENT_POLL_CRON = "0 * * * * *";

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

function isTerminal(status: RequirementStatus): boolean {
  return (
    status.externalState === "completed" ||
    status.externalState === "closed"
  );
}

function linkedPullRequests(
  resources: ResourceClient,
  requirementResourceId: string,
): readonly Readonly<Resource<PullRequestSpec, PullRequestStatus>>[] {
  return resources
    .list<PullRequestSpec, PullRequestStatus>(
      PULL_REQUEST_RESOURCE_KIND,
    )
    .filter(({ status }) =>
      status.requirementAssociation?.state === "linked" &&
      status.requirementAssociation.requirement.resourceOwner === "plugin" &&
      status.requirementAssociation.requirement.resourceKind ===
        REQUIREMENT_RESOURCE_KIND &&
      status.requirementAssociation.requirement.resourceId ===
        requirementResourceId &&
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

function closeReminderKey(
  pullRequests: readonly Readonly<
    Resource<PullRequestSpec, PullRequestStatus>
  >[],
): string | undefined {
  if (
    pullRequests.length === 0 ||
    pullRequests.some(({ status }) =>
      status.lifecycle !== "merged" ||
      (
        status.reviewThreads !== "none" &&
        status.reviewThreads !== "resolved"
      )
    )
  ) {
    return;
  }
  return pullRequests
    .map(({ metadata }) =>
      `${metadata.resourceId}@${metadata.resourceVersion}`
    )
    .sort()
    .join(",");
}

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
    resourceKind: REQUIREMENT_RESOURCE_KIND,
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
    async reconcile(_baton, resource) {
      if (!resources) return;
      let current = resource;
      const connector = connectorsBySource.get(
        resource.spec.identity.source,
      );
      if (connector) {
        const observation: Requirement = await connector.get(
          resource.spec.identity,
        );
        if (!sameIdentity(observation, resource.spec.identity)) {
          throw new Error(
            "RequirementConnector returned a different Requirement",
          );
        }
        current = upsertRequirement(resources, observation);
      }
      if (isTerminal(current.status)) return;

      const pullRequests = linkedPullRequests(
        resources,
        current.metadata.resourceId,
      );
      current = resources.patchStatus(current, {
        linkedPullRequests: summarizePullRequests(pullRequests),
      });
      const reminderKey = closeReminderKey(pullRequests);
      if (
        !reminderKey ||
        current.status.closeReminderKey === reminderKey ||
        !toast
      ) {
        return;
      }
      const target = current.status.url
        ? ` at ${current.status.url}`
        : ` in ${current.spec.identity.source}`;
      toast.show({
        text:
          `Requirement "${current.spec.title}" looks ready to close. ` +
          `Please close it${target}.`,
        tone: "info",
      });
      resources.patchStatus(current, { closeReminderKey: reminderKey });
    },
    present(resource) {
      const state = resource.status.externalState;
      if (state === "completed" || state === "closed") return undefined;
      const pullRequests = resource.status.linkedPullRequests;
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
        ]
        : [];
      return {
        title: resource.spec.title,
        status: [state ?? "Not observed", ...pullRequestStatus].join(" · "),
        ...(resource.spec.description
          ? { detail: resource.spec.description }
          : {}),
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
