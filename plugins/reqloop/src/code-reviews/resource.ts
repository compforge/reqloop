import { createHash } from "node:crypto";

import type {
  Resource,
  ResourceClient,
} from "@compforge/baton-plugin";

import type {
  CodeReviewObservation,
  CodeReviewSpec,
  CodeReviewStatus,
} from "./protocol.ts";

export const CODE_REVIEW_RESOURCE_TYPE = Object.freeze({
  apiVersion: "reqloop.baton.dev/v1alpha2",
  kind: "CodeReview",
  shortNames: ["cr"],
} as const);

export function codeReviewSpec(
  observation: CodeReviewObservation,
): CodeReviewSpec {
  const forge = observation.pullRequest.forge.trim();
  const path = observation.pullRequest.path.trim();
  const runKey = observation.key.trim();
  const revision = observation.sha.trim();
  if (!forge || !path || !runKey || !revision) {
    throw new Error("CodeReview identity fields must not be empty");
  }
  if (
    !Number.isSafeInteger(observation.pullRequest.number) ||
    observation.pullRequest.number < 1
  ) {
    throw new Error(
      "CodeReview PullRequest number must be positive",
    );
  }
  return {
    pullRequest: {
      forge,
      path,
      number: observation.pullRequest.number,
    },
    runKey,
    revision,
  };
}

/** Stable host-safe identity for one published code-review run. */
export function codeReviewResourceName(spec: CodeReviewSpec): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([
      spec.pullRequest.forge,
      spec.pullRequest.path,
      spec.pullRequest.number,
      spec.runKey,
    ]))
    .digest("hex")
    .slice(0, 24);
  return `code-review-${digest}`;
}

function sameCodeReview(
  spec: CodeReviewSpec,
  observation: CodeReviewObservation,
): boolean {
  return (
    spec.runKey === observation.key &&
    spec.revision === observation.sha &&
    spec.pullRequest.forge === observation.pullRequest.forge &&
    spec.pullRequest.path === observation.pullRequest.path &&
    spec.pullRequest.number === observation.pullRequest.number
  );
}

export async function updateCodeReviewObservation(
  resources: ResourceClient,
  resource: Readonly<Resource<CodeReviewSpec, CodeReviewStatus>>,
  observation: CodeReviewObservation,
  status: CodeReviewStatus,
): Promise<Readonly<Resource<CodeReviewSpec, CodeReviewStatus>>> {
  if (!sameCodeReview(resource.spec, observation)) {
    throw new Error(
      `Forge comments returned a different CodeReview for ` +
        `${resource.metadata.name}`,
    );
  }
  return await resources.patchStatus(resource, status);
}
