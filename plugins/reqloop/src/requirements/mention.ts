import type {
  Mention,
  Resource,
  ResourceClient,
  ResourceNamespace,
} from "@compforge/baton-plugin";

import type {
  RequirementSpec,
  RequirementStatus,
} from "./protocol.ts";
import {
  isRequirementActive,
} from "./conditions.ts";
import { REQUIREMENT_RESOURCE_TYPE } from "./resource.ts";

type RequirementResource = Readonly<
  Resource<RequirementSpec, RequirementStatus>
>;

function searchableText(resource: RequirementResource): string {
  return [
    resource.spec.title,
    resource.spec.identity.source,
    resource.spec.identity.category,
    resource.spec.identity.id,
    resource.spec.description,
    resource.spec.acceptanceCriteria?.join(" "),
    resource.status.externalState,
    resource.status.assignee,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .toLocaleLowerCase();
}

function requirementContext(resource: RequirementResource): string {
  const { identity } = resource.spec;
  const lines = [
    `Requirement: ${resource.spec.title}`,
    `Source: ${identity.source}`,
    `ID: ${identity.id}`,
    `Category: ${identity.category}`,
    `Status: ${resource.status.externalState ?? "unknown"}`,
    ...(resource.status.assignee
      ? [`Assignee: ${resource.status.assignee}`]
      : []),
    ...(resource.status.updatedAt
      ? [`Updated: ${resource.status.updatedAt}`]
      : []),
    ...(resource.status.url ? [`URL: ${resource.status.url}`] : []),
    ...(resource.spec.description
      ? ["", resource.spec.description]
      : []),
  ];
  if (resource.spec.acceptanceCriteria?.length) {
    lines.push(
      "",
      "Acceptance criteria:",
      ...resource.spec.acceptanceCriteria.map(
        (criterion) => `- ${criterion}`,
      ),
    );
  }
  if (resource.status.linkedPullRequests?.total) {
    const linked = resource.status.linkedPullRequests;
    lines.push(
      "",
      `Linked pull requests: ${linked.total}`,
      `Open: ${linked.open}`,
      `Merged: ${linked.merged}`,
      `Merge conflicts: ${linked.conflicted}`,
      `Unresolved review threads: ${linked.unresolvedReviewThreads}`,
    );
  }
  return lines.join("\n");
}

export function createRequirementMention(
  resources: ResourceClient,
  namespace: ResourceNamespace = "v1",
): Mention {
  return {
    namespace: "requirement",
    async search(query) {
      const normalizedQuery = query.trim().toLocaleLowerCase();
      return (await resources.list<RequirementSpec, RequirementStatus>(
        REQUIREMENT_RESOURCE_TYPE,
        { namespace },
      ))
        .filter((resource) => isRequirementActive(resource.status))
        .filter((resource) =>
          !normalizedQuery ||
          searchableText(resource).includes(normalizedQuery)
        )
        .sort((left, right) =>
          (right.status.updatedAt ?? right.metadata.creationTimestamp)
            .localeCompare(
              left.status.updatedAt ?? left.metadata.creationTimestamp,
            )
        )
        .map((resource) => ({
          id: resource.metadata.name,
          label: resource.spec.title,
          description: [
            resource.spec.identity.source,
            resource.spec.identity.category,
            resource.spec.identity.id,
            resource.status.externalState ?? "unknown",
          ].join(" · "),
        }));
    },
    async resolve(id, { maxChars }) {
      const resource = (await resources.list<
        RequirementSpec,
        RequirementStatus
      >(
        REQUIREMENT_RESOURCE_TYPE,
        { namespace },
      ))
        .find(({ metadata }) => metadata.name === id);
      if (!resource) return;
      return requirementContext(resource).slice(0, maxChars);
    },
  };
}
