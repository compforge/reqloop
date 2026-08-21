import { createHash } from "node:crypto";

import type {
  RepositoryIdentity,
} from "./protocol.ts";

export const REPOSITORY_RESOURCE_TYPE = Object.freeze({
  apiVersion: "reqloop.baton.dev/v1alpha2",
  kind: "Repository",
} as const);

export function normalizeRepositoryIdentity(
  identity: RepositoryIdentity,
): RepositoryIdentity {
  const forge = identity.forge.trim();
  const path = identity.path.trim();
  if (!forge || !path) {
    throw new Error("Repository identity fields must not be empty");
  }
  return { forge, path };
}

export function repositoryResourceName(
  identity: RepositoryIdentity,
): string {
  const normalized = normalizeRepositoryIdentity(identity);
  const digest = createHash("sha256")
    .update(JSON.stringify([normalized.forge, normalized.path]))
    .digest("hex")
    .slice(0, 24);
  return `repo-${digest}`;
}
