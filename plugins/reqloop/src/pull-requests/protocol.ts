import type { ResourceRef } from "@compforge/baton-plugin";
import type { RepositoryIdentity } from "../repositories/protocol.ts";

/** Stable external identity shared by GitHub PRs and GitLab MRs. */
export interface PullRequestIdentity extends RepositoryIdentity {
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
  readonly title?: string;
  readonly url?: string;
  readonly lifecycle?: PullRequestLifecycle;
  readonly reviewThreads?: PullRequestReviewThreads;
  /** Opaque Forge-derived fingerprint; a change means review activity changed. */
  readonly reviewActivityKey?: string | null;
  readonly mergeability?: PullRequestMergeability;
  readonly observedAt?: string;
  /**
   * Absence means Resource status has no association decision.
   * `prompted` records that the user dismissed or timed out the question.
   */
  readonly requirementAssociation?: PullRequestRequirementAssociation;
  /** One durable user decision for the current merge-conflict episode. */
  readonly mergeConflictDecision?: {
    readonly choice?: "accept" | "ignore";
    /** Terminal Harness Turn created from the accepted draft. */
    readonly followUpTurnId?: string;
  } | null;
}

export interface PullRequest {
  readonly identity: PullRequestIdentity;
  readonly title: string;
  readonly url: string;
  readonly lifecycle: PullRequestLifecycle;
  readonly reviewThreads: PullRequestReviewThreads;
  readonly reviewActivityKey?: string;
  readonly mergeability: PullRequestMergeability;
  readonly observedAt: string;
}

/** One top-level provider-neutral comment, with review replies nested. */
export interface Comment {
  readonly id: string;
  readonly body: string;
  readonly author?: string;
  readonly replyable: boolean;
  readonly replies: readonly Comment[];
  readonly path?: string;
  readonly line?: number;
  readonly createdAt: string;
}

export interface PullRequestListQuery {
  readonly state: "open" | "merged";
  /** Maximum number of provider results returned for this query. */
  readonly limit: number;
}

export class ForgeRateLimitError extends Error {
  readonly retryAfterMs: number;

  constructor(message: string, retryAfterMs: number) {
    super(message);
    this.name = "ForgeRateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

export function isForgeRateLimitError(
  error: unknown,
): error is ForgeRateLimitError {
  return error instanceof ForgeRateLimitError;
}

/**
 * Read-only provider boundary for PullRequest discovery and observation.
 * `source` selects one configured Forge without leaking provider details into
 * the Resource identity.
 */
export interface ForgeConnector {
  readonly forge: string;
  readonly provider: "github" | "gitlab";
  /** Lists provider objects; the calling Source owns the admission policy. */
  list(
    path: string,
    query: PullRequestListQuery,
  ): Promise<readonly PullRequestIdentity[]>;
  get(identity: PullRequestIdentity): Promise<PullRequest>;
  /** Reads both conversation and diff-anchored comments in creation order. */
  comments?(
    identity: PullRequestIdentity,
  ): Promise<readonly Comment[]>;
}
