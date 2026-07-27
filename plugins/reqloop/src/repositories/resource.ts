import { createHash } from "node:crypto";

import type {
  Resource,
  ResourceClient,
} from "@qiankun01/baton-plugin";

import type {
  RepositoryIdentity,
  RepositorySpec,
  RepositoryStatus,
} from "./protocol.ts";

export const REPOSITORY_RESOURCE_TYPE = Object.freeze({
  apiVersion: "reqloop.baton.dev/v1alpha1",
  kind: "Repository",
} as const);

function normalizedIdentity(
  identity: RepositoryIdentity,
): RepositoryIdentity {
  const source = identity.source.trim();
  const repository = identity.repository.trim();
  if (!source || !repository) {
    throw new Error("Repository identity fields must not be empty");
  }
  return { source, repository };
}

function sameIdentity(
  left: RepositoryIdentity,
  right: RepositoryIdentity,
): boolean {
  return (
    left.source === right.source &&
    left.repository === right.repository
  );
}

export function repositoryResourceName(
  identity: RepositoryIdentity,
): string {
  const normalized = normalizedIdentity(identity);
  const digest = createHash("sha256")
    .update(JSON.stringify([normalized.source, normalized.repository]))
    .digest("hex")
    .slice(0, 24);
  return `repo-${digest}`;
}

/** Ensures one observation owner exists for each external repository. */
export function ensureRepositoryResource(
  resources: ResourceClient,
  requestedIdentity: RepositoryIdentity,
): Readonly<Resource<RepositorySpec, RepositoryStatus>> {
  const identity = normalizedIdentity(requestedIdentity);
  const name = repositoryResourceName(identity);
  let resource = resources
    .list<RepositorySpec, RepositoryStatus>(
      REPOSITORY_RESOURCE_TYPE,
    )
    .find((candidate) => candidate.metadata.name === name);

  if (!resource) {
    resource = resources.create<RepositorySpec, RepositoryStatus>(
      REPOSITORY_RESOURCE_TYPE,
      {
        name,
        spec: { identity },
      },
    );
  } else if (!sameIdentity(resource.spec.identity, identity)) {
    throw new Error(`Repository Resource identity mismatch: ${name}`);
  }
  return resource;
}
