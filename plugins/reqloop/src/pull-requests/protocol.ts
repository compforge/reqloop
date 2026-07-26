import type { ResourceRef } from "@qiankun01/baton-plugin";

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
  | "none"
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

export type PullRequestRequirementAssociation =
  | {
      readonly state: "prompted";
      readonly decisionKey: string;
    }
  | {
      readonly state: "linked";
      readonly requirement: ResourceRef;
    }
  | {
      readonly state: "standalone";
    };

/** Empty status means the external PR/MR has not been observed yet. */
export interface PullRequestStatus {
  readonly lifecycle?: PullRequestLifecycle;
  readonly reviewThreads?: PullRequestReviewThreads;
  /** Opaque Forge-derived fingerprint; a change means review activity changed. */
  readonly reviewActivityKey?: string | null;
  readonly mergeability?: PullRequestMergeability;
  readonly observedAt?: string;
  /**
   * Absence means the association question has not been asked. `prompted`
   * remains durable even if the interaction is cancelled, so it is asked once.
   */
  readonly requirementAssociation?: PullRequestRequirementAssociation;
  readonly review?: PullRequestReviewStatus;
}

export interface PullRequest {
  readonly identity: PullRequestIdentity;
  readonly lifecycle: PullRequestLifecycle;
  readonly reviewThreads: PullRequestReviewThreads;
  readonly reviewActivityKey?: string;
  readonly mergeability: PullRequestMergeability;
  readonly observedAt: string;
}

export interface PullRequestReviewFinding {
  readonly path: string;
  readonly message: string;
  readonly status?: string;
}

export interface PullRequestReviewObservation {
  readonly identity: PullRequestIdentity;
  readonly key: string;
  readonly status: string;
  readonly sha: string;
  readonly count: number;
  readonly failed: number;
  readonly findings: readonly PullRequestReviewFinding[];
  readonly reviewedRange?: string;
  readonly posted?: string;
  readonly completedAt?: number;
  readonly branch?: string;
}

export interface PullRequestReviewStatus {
  readonly key: string;
  readonly status: string;
  readonly sha: string;
  readonly findingCount: number;
  readonly failedFileCount: number;
  readonly completedAt?: number;
}

export interface PullRequestReviewConnector {
  latest(): PullRequestReviewObservation | undefined;
}

/**
 * Read-only provider boundary for PullRequest discovery and observation.
 * `source` selects one configured Forge without leaking provider details into
 * the Resource identity.
 */
export interface ForgeConnector {
  readonly source: string;
  readonly provider: "github" | "gitlab";
  list(
    repository: string,
    limit?: number,
  ): Promise<readonly PullRequestIdentity[]>;
  get(identity: PullRequestIdentity): Promise<PullRequest>;
}
