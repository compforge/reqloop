import { createHash } from "node:crypto";

import type {
  Resource,
  ResourceClient,
} from "@qiankun01/baton-plugin";

import type {
  PullRequestIdentity,
  PullRequest,
  PullRequestReviewObservation,
  PullRequestSpec,
  PullRequestStatus,
} from "./protocol.ts";

export const PULL_REQUEST_RESOURCE_TYPE = Object.freeze({
  apiVersion: "reqloop.baton.dev/v1alpha1",
  kind: "PullRequest",
} as const);

function normalizedIdentity(
  identity: PullRequestIdentity,
): PullRequestIdentity {
  const source = identity.source.trim();
  const repository = identity.repository.trim();
  if (!source) throw new Error("PullRequest source must not be empty");
  if (!repository) {
    throw new Error("PullRequest repository must not be empty");
  }
  if (!Number.isSafeInteger(identity.number) || identity.number < 1) {
    throw new Error("PullRequest number must be a positive integer");
  }
  return { source, repository, number: identity.number };
}

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

/** Stable host-safe identity for one external PR/MR across repeated discovery. */
export function pullRequestResourceId(
  identity: PullRequestIdentity,
): string {
  const normalized = normalizedIdentity(identity);
  const digest = createHash("sha256")
    .update(JSON.stringify([
      normalized.source,
      normalized.repository,
      normalized.number,
    ]))
    .digest("hex")
    .slice(0, 24);
  return `pr_${digest}`;
}

/**
 * Materializes the latest Forge observation without making Connector state a
 * second source of truth. Re-observing the same PR/MR targets the same Resource.
 */
export function upsertPullRequest(
  resources: ResourceClient,
  observation: PullRequest,
): Readonly<Resource<PullRequestSpec, PullRequestStatus>> {
  const resource = ensurePullRequestResource(
    resources,
    observation.identity,
  );
  return resources.patchStatus(resource, {
    lifecycle: observation.lifecycle,
    reviewThreads: observation.reviewThreads,
    reviewActivityKey:
      observation.reviewActivityKey ??
      (observation.reviewThreads === "unknown"
        ? resource.status.reviewActivityKey ?? null
        : null),
    mergeability: observation.mergeability,
    observedAt: observation.observedAt,
  });
}

export function ensurePullRequestResource(
  resources: ResourceClient,
  requestedIdentity: PullRequestIdentity,
): Readonly<Resource<PullRequestSpec, PullRequestStatus>> {
  const identity = normalizedIdentity(requestedIdentity);
  const name = pullRequestResourceId(identity);
  let resource = resources
    .list<PullRequestSpec, PullRequestStatus>(PULL_REQUEST_RESOURCE_TYPE)
    .find((candidate) => candidate.metadata.name === name);

  if (!resource) {
    resource = resources.create<PullRequestSpec, PullRequestStatus>(
      PULL_REQUEST_RESOURCE_TYPE,
      {
        name,
        spec: { identity },
      },
    );
  } else if (!sameIdentity(resource.spec.identity, identity)) {
    throw new Error(
      `PullRequest Resource identity mismatch: ${name}`,
    );
  }
  return resource;
}

export function upsertPullRequestReview(
  resources: ResourceClient,
  observation: PullRequestReviewObservation,
): Readonly<Resource<PullRequestSpec, PullRequestStatus>> {
  const resource = ensurePullRequestResource(
    resources,
    observation.identity,
  );
  return resources.patchStatus(resource, {
    review: {
      key: observation.key,
      status: observation.status,
      sha: observation.sha,
      findingCount: observation.count,
      failedFileCount: observation.failed,
      ...(observation.completedAt !== undefined
        ? { completedAt: observation.completedAt }
        : {}),
    },
  });
}
