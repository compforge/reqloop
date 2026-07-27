import { createHash } from "node:crypto";

import type {
  Resource,
  ResourceClient,
} from "@qiankun01/baton-plugin";

import type {
  Requirement,
  RequirementIdentity,
  RequirementSpec,
  RequirementStatus,
} from "./protocol.ts";

export const REQUIREMENT_RESOURCE_TYPE = Object.freeze({
  apiVersion: "reqloop.baton.dev/v1alpha1",
  kind: "Requirement",
} as const);

function normalizedIdentity(
  identity: RequirementIdentity,
): RequirementIdentity {
  const source = identity.source.trim();
  const category = identity.category.trim();
  const id = identity.id.trim();
  if (!source || !category || !id) {
    throw new Error("Requirement identity fields must not be empty");
  }
  return { source, category, id };
}

export function requirementResourceId(
  identity: RequirementIdentity,
): string {
  const normalized = normalizedIdentity(identity);
  const digest = createHash("sha256")
    .update(JSON.stringify([
      normalized.source,
      normalized.category,
      normalized.id,
    ]))
    .digest("hex")
    .slice(0, 24);
  return `req_${digest}`;
}

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

export function upsertRequirement(
  resources: ResourceClient,
  requirement: Requirement,
): Readonly<Resource<RequirementSpec, RequirementStatus>> {
  const identity = normalizedIdentity(requirement);
  const name = requirementResourceId(identity);
  let resource = resources
    .list<RequirementSpec, RequirementStatus>(REQUIREMENT_RESOURCE_TYPE)
    .find((candidate) => candidate.metadata.name === name);

  if (!resource) {
    resource = resources.create<RequirementSpec, RequirementStatus>(
      REQUIREMENT_RESOURCE_TYPE,
      {
        name,
        spec: {
          identity,
          title: requirement.title,
          ...(requirement.description !== undefined
            ? { description: requirement.description }
            : {}),
          ...(requirement.acceptanceCriteria !== undefined
            ? { acceptanceCriteria: requirement.acceptanceCriteria }
            : {}),
        },
      },
    );
  } else if (!sameIdentity(resource.spec.identity, identity)) {
    throw new Error(`Requirement Resource identity mismatch: ${name}`);
  }
  return resources.patchStatus(resource, {
    externalState: requirement.state,
    ...(requirement.assignee !== undefined
      ? { assignee: requirement.assignee }
      : {}),
    ...(requirement.updatedAt !== undefined
      ? { updatedAt: requirement.updatedAt }
      : {}),
    ...(requirement.url !== undefined ? { url: requirement.url } : {}),
  });
}
