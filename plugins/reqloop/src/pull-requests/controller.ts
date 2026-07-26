import type {
  BoardPresentation,
  Controller,
  Resource,
} from "@qiankun01/baton-plugin";

import type {
  PullRequestSpec,
  PullRequestStatus,
} from "./protocol.ts";
import { PULL_REQUEST_RESOURCE_KIND } from "./resource.ts";

function presentPullRequest(
  resource: Readonly<Resource<PullRequestSpec, PullRequestStatus>>,
): BoardPresentation {
  const { identity } = resource.spec;
  const { lifecycle, reviewThreads, mergeability } = resource.status;
  const blockers = [
    reviewThreads === "unresolved" ? "unresolved review threads" : undefined,
    mergeability === "conflicted" ? "merge conflict" : undefined,
  ].filter((item): item is string => item !== undefined);

  let tone: BoardPresentation["tone"] = "muted";
  if (lifecycle === "merged" || lifecycle === "closed") {
    tone = "success";
  } else if (mergeability === "conflicted") {
    tone = "error";
  } else if (reviewThreads === "unresolved") {
    tone = "warning";
  } else if (lifecycle === "open") {
    tone = "default";
  }

  return {
    title: `${identity.repository} #${identity.number}`,
    status: lifecycle ?? "unobserved",
    ...(blockers.length > 0 ? { detail: blockers.join(" · ") } : {}),
    tone,
  };
}

/**
 * A concrete ForgeConnector will add observation work here. Registering the
 * Controller now makes persisted PullRequest Resources visible and stable.
 */
export function createPullRequestController(): Controller<
  PullRequestSpec,
  PullRequestStatus
> {
  return {
    resourceKind: PULL_REQUEST_RESOURCE_KIND,
    async reconcile() {},
    present: presentPullRequest,
  };
}
