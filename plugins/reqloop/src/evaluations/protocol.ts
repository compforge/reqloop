import type { PullRequestIdentity } from "../pull-requests/protocol.ts";

export interface CodeReviewEvaluationSpec {
  readonly kind: "code-review";
  readonly target: {
    readonly kind: "pull-request";
    readonly identity: PullRequestIdentity;
  };
  /** Stable identity of one AI review run. */
  readonly runKey: string;
  /** Immutable revision reviewed by this run. */
  readonly revision: string;
}

/** Extend this union only when another Evaluation kind is implemented. */
export type EvaluationSpec = CodeReviewEvaluationSpec;

export type EvaluationPhase =
  | "pending"
  | "running"
  | "completed"
  | "failed";

export type EvaluationVerdict =
  | "passed"
  | "action-required"
  | "skipped"
  | "failed";

export interface CodeReviewFinding {
  readonly path: string;
  readonly message: string;
  readonly status?: string;
  readonly fingerprint?: string;
  readonly commentId?: string;
  readonly threadId?: string;
}

export interface CodeReviewEvaluationResult {
  readonly kind: "code-review";
  readonly findingCount: number;
  readonly failedFileCount: number;
  readonly findings: readonly CodeReviewFinding[];
  readonly summaryCommentId: string;
  readonly reviewedRange?: string;
  /**
   * Human-readable producer result for optional Forge publication. Evaluation
   * identity does not depend on whether any comment was posted.
   */
  readonly publicationSummary?: string;
}

export interface EvaluationStatus {
  readonly phase?: EvaluationPhase;
  readonly verdict?: EvaluationVerdict;
  readonly result?: CodeReviewEvaluationResult;
  readonly completedAt?: string;
  readonly expiresAt?: string;
  readonly decision?: {
    readonly choice: "accept" | "ignore";
    readonly decidedAt: string;
  };
}

/** Terminal devloop fact mapped into a code-review Evaluation. */
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
