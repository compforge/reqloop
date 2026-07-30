import type { PullRequestIdentity } from "../pull-requests/protocol.ts";

export interface CodeReviewSpec {
  /** PullRequest reviewed by this run. */
  readonly pullRequest: PullRequestIdentity;
  /** Stable identity of one published AI review run. */
  readonly runKey: string;
  /** Immutable revision reviewed by this run. */
  readonly revision: string;
}

export type CodeReviewPhase =
  | "pending"
  | "running"
  | "completed"
  | "failed";

export type CodeReviewVerdict =
  | "passed"
  | "action-required"
  | "skipped"
  | "failed";

export type CodeReviewLabel =
  | "important"
  | "minor"
  | "debatable"
  | "wrong";

export interface CodeReviewFinding {
  readonly path: string;
  readonly message: string;
  readonly status?: string;
  readonly fingerprint?: string;
  readonly commentId?: string;
  /** First valid ccr:label reply observed on this Forge comment. */
  readonly label?: CodeReviewLabel;
}

export interface CodeReviewResult {
  readonly findingCount: number;
  readonly failedFileCount: number;
  readonly findings: readonly CodeReviewFinding[];
  readonly summaryCommentId: string;
  readonly reviewedRange?: string;
  /**
   * Human-readable producer result published on the Forge.
   */
  readonly publicationSummary?: string;
}

export interface CodeReviewStatus {
  readonly phase?: CodeReviewPhase;
  readonly verdict?: CodeReviewVerdict;
  readonly result?: CodeReviewResult;
  readonly completedAt?: string;
  readonly expiresAt?: string;
  readonly decision?: {
    readonly choice: "accept" | "ignore";
    readonly decidedAt: string;
  };
}

/** Terminal devloop review run reconstructed from its Forge comments. */
export interface CodeReviewObservation {
  readonly pullRequest: PullRequestIdentity;
  readonly key: string;
  readonly sha: string;
  readonly count: number;
  readonly failed: number;
  readonly findings: readonly CodeReviewFinding[];
  readonly reviewedRange?: string;
  readonly publicationSummary?: string;
  readonly completedAt: string;
}
