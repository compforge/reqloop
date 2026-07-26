/** Stable external identity shared by GitHub PRs and GitLab MRs. */
export interface PullRequestIdentity {
  /** Configured ForgeConnector source. */
  readonly source: string;
  /** Provider-neutral repository identity, for example owner/repo. */
  readonly repository: string;
  /** GitHub PR number or GitLab MR iid. */
  readonly number: number;
}

export type PullRequestLifecycle = "open" | "merged" | "closed";
export type PullRequestReviewThreads =
  | "unresolved"
  | "resolved"
  | "unknown";
export type PullRequestMergeability =
  | "ready"
  | "conflicted"
  | "unknown";

export interface PullRequestSpec {
  readonly identity: PullRequestIdentity;
}

/** Empty status means the external PR/MR has not been observed yet. */
export interface PullRequestStatus {
  readonly lifecycle?: PullRequestLifecycle;
  readonly reviewThreads?: PullRequestReviewThreads;
  readonly mergeability?: PullRequestMergeability;
  readonly observedAt?: string;
}

export interface PullRequestObservation {
  readonly identity: PullRequestIdentity;
  readonly lifecycle: PullRequestLifecycle;
  readonly reviewThreads: PullRequestReviewThreads;
  readonly mergeability: PullRequestMergeability;
  readonly observedAt: string;
}
