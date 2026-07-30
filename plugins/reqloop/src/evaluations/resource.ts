import { createHash } from "node:crypto";

import type {
  Resource,
  ResourceClient,
} from "@compforge/baton-plugin";

import type {
  CodeReviewObservation,
  EvaluationSpec,
  EvaluationStatus,
} from "./protocol.ts";

export const EVALUATION_RESOURCE_TYPE = Object.freeze({
  apiVersion: "reqloop.baton.dev/v1alpha1",
  kind: "Evaluation",
  shortNames: ["eval"],
} as const);

export function codeReviewEvaluationSpec(
  observation: CodeReviewObservation,
): EvaluationSpec {
  const source = observation.pullRequest.source.trim();
  const repository = observation.pullRequest.repository.trim();
  const runKey = observation.key.trim();
  const revision = observation.sha.trim();
  if (!source || !repository || !runKey || !revision) {
    throw new Error("Code review Evaluation identity fields must not be empty");
  }
  if (
    !Number.isSafeInteger(observation.pullRequest.number) ||
    observation.pullRequest.number < 1
  ) {
    throw new Error(
      "Code review Evaluation PullRequest number must be positive",
    );
  }
  return {
    kind: "code-review",
    target: {
      kind: "pull-request",
      identity: {
        source,
        repository,
        number: observation.pullRequest.number,
      },
    },
    runKey,
    revision,
  };
}

/** Stable host-safe identity for one Evaluation task. */
export function evaluationResourceName(spec: EvaluationSpec): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([
      spec.kind,
      spec.target.kind,
      spec.target.identity.source,
      spec.target.identity.repository,
      spec.target.identity.number,
      spec.runKey,
    ]))
    .digest("hex")
    .slice(0, 24);
  return `evaluation-${digest}`;
}

function sameEvaluation(
  spec: EvaluationSpec,
  observation: CodeReviewObservation,
): boolean {
  return (
    spec.kind === "code-review" &&
    spec.runKey === observation.key &&
    spec.revision === observation.sha &&
    spec.target.identity.source === observation.pullRequest.source &&
    spec.target.identity.repository === observation.pullRequest.repository &&
    spec.target.identity.number === observation.pullRequest.number
  );
}

export async function updateEvaluationObservation(
  resources: ResourceClient,
  resource: Readonly<Resource<EvaluationSpec, EvaluationStatus>>,
  observation: CodeReviewObservation,
  status: EvaluationStatus,
): Promise<Readonly<Resource<EvaluationSpec, EvaluationStatus>>> {
  if (!sameEvaluation(resource.spec, observation)) {
    throw new Error(
      `EvaluationConnector returned a different Evaluation for ` +
        `${resource.metadata.name}`,
    );
  }
  return await resources.patchStatus(resource, status);
}
