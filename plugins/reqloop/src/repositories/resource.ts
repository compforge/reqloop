import { createHash } from "node:crypto";

import type {
  RepositoryIdentity,
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
