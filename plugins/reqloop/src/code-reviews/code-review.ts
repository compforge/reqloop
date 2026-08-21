import type {
  CodeReviewLabel,
  CodeReviewObservation,
  CodeReviewSpec,
  CodeReviewStatus,
} from "./protocol.ts";
import type { Comment } from "../pull-requests/protocol.ts";

export const CODE_REVIEW_ACTIVE_TTL_MS = 24 * 60 * 60_000;

const SUMMARY_RE =
  /^🤖 \*\*devloop code-review\*\* · `([^`]+)` · `([0-9a-f]+)`/im;
const FINDING_COUNT_RE = /\*\*(\d+) finding\(s\)\*\*/i;
const FAILED_COUNT_RE = /(\d+) 个文件未能 review/i;
const FINGERPRINT_RE = /ccr:fp=([A-Za-z0-9_-]+)/;
const LABEL_RE = /ccr:label=([A-Za-z]+)/;
const CODE_REVIEW_LABELS = new Set<CodeReviewLabel>([
  "important",
  "minor",
  "debatable",
  "wrong",
]);

export function codeReviewExpiresAt(
  observation: CodeReviewObservation,
  ttlMs: number = CODE_REVIEW_ACTIVE_TTL_MS,
): number {
  const completedAt = Date.parse(observation.completedAt);
  if (!Number.isFinite(completedAt)) {
    throw new Error(
      `Code review comment has invalid createdAt: ${observation.completedAt}`,
    );
  }
  return completedAt + ttlMs;
}

function summary(
  comment: Comment,
): {
  readonly range: string;
  readonly sha: string;
  readonly count: number;
  readonly failed: number;
} | undefined {
  const header = SUMMARY_RE.exec(comment.body);
  if (!header) return;
  return {
    range: header[1]!,
    sha: header[2]!,
    count: Number(FINDING_COUNT_RE.exec(comment.body)?.[1] ?? 0),
    failed: Number(FAILED_COUNT_RE.exec(comment.body)?.[1] ?? 0),
  };
}

function commentFinding(
  comment: Comment,
): CodeReviewObservation["findings"][number] | undefined {
  if (!comment.replyable) return;
  const fingerprint = FINGERPRINT_RE.exec(comment.body)?.[1];
  if (!fingerprint) return;
  const label = comment.replies
    .map((reply) => LABEL_RE.exec(reply.body)?.[1])
    .find((candidate): candidate is CodeReviewLabel =>
      CODE_REVIEW_LABELS.has(candidate as CodeReviewLabel)
    );
  const message = comment.body
    .replace(/^🤖 \*\*devloop code-review\*\*(?: · [^\n]+)?\s*/i, "")
    .replace(/\s*<sub>ccr:fp=[^<]+<\/sub>\s*$/i, "")
    .trim();
  return {
    path: comment.path ?? "?",
    message,
    fingerprint,
    commentId: comment.id,
    ...(label ? { label } : {}),
  };
}

function observationAt(
  pullRequest: CodeReviewObservation["pullRequest"],
  comments: readonly Comment[],
  summaryIndex: number,
): CodeReviewObservation | undefined {
  const comment = comments[summaryIndex];
  if (!comment) return;
  const parsed = summary(comment);
  if (!parsed || (parsed.count === 0 && parsed.failed === 0)) return;
  let previousSummaryIndex = -1;
  for (let index = summaryIndex - 1; index >= 0; index -= 1) {
    if (comments[index] && summary(comments[index]!)) {
      previousSummaryIndex = index;
      break;
    }
  }
  const findings = comments
    .slice(previousSummaryIndex + 1, summaryIndex)
    .flatMap((candidate) => {
      const finding = commentFinding(candidate);
      return finding ? [finding] : [];
    });
  return {
    pullRequest,
    key: comment.id,
    sha: parsed.sha,
    count: parsed.count,
    failed: parsed.failed,
    findings,
    reviewedRange: parsed.range,
    publicationSummary: comment.body,
    completedAt: comment.createdAt,
  };
}

export function latestCodeReviewObservation(
  pullRequest: CodeReviewObservation["pullRequest"],
  comments: readonly Comment[],
): CodeReviewObservation | undefined {
  return codeReviewObservations(pullRequest, comments).at(-1);
}

/** Every published actionable review run, ordered by its summary comment. */
export function codeReviewObservations(
  pullRequest: CodeReviewObservation["pullRequest"],
  comments: readonly Comment[],
): readonly CodeReviewObservation[] {
  const observations: CodeReviewObservation[] = [];
  for (let index = 0; index < comments.length; index += 1) {
    const observation = observationAt(pullRequest, comments, index);
    if (observation) observations.push(observation);
  }
  return observations;
}

export function codeReviewObservation(
  spec: CodeReviewSpec,
  comments: readonly Comment[],
): CodeReviewObservation | undefined {
  const index = comments.findIndex(({ id }) => id === spec.runKey);
  if (index < 0) return;
  return observationAt(spec.pullRequest, comments, index);
}

export function codeReviewStatus(
  observation: CodeReviewObservation,
  ttlMs: number = CODE_REVIEW_ACTIVE_TTL_MS,
): CodeReviewStatus {
  const completedAt = Date.parse(observation.completedAt);
  if (!Number.isFinite(completedAt)) {
    throw new Error(
      `Code review comment has invalid createdAt: ${observation.completedAt}`,
    );
  }
  const verdict = observation.count > 0 || observation.failed > 0
    ? "action-required"
    : "passed";
  return {
    phase: "completed",
    verdict,
    result: {
      findingCount: observation.count,
      failedFileCount: observation.failed,
      findings: observation.findings,
      summaryCommentId: observation.key,
      ...(observation.reviewedRange
        ? { reviewedRange: observation.reviewedRange }
        : {}),
      ...(observation.publicationSummary
        ? { publicationSummary: observation.publicationSummary }
        : {}),
    },
    completedAt: new Date(completedAt).toISOString(),
    expiresAt: new Date(completedAt + ttlMs).toISOString(),
  };
}

export function actionableCodeReview(status: CodeReviewStatus): boolean {
  return status.verdict === "failed" ||
    status.verdict === "action-required";
}

export function codeReviewLabelProgress(
  status: CodeReviewStatus,
): {
  readonly labeled: number;
  readonly total: number;
  readonly complete: boolean;
} {
  const findings = status.result?.findings ?? [];
  const labeled = findings.filter(({ label }) => label !== undefined).length;
  return {
    labeled,
    total: findings.length,
    complete: findings.length > 0 && labeled === findings.length,
  };
}

/** Whether this review should still occupy Board attention. */
export function codeReviewNeedsAttention(
  status: CodeReviewStatus,
): boolean {
  if (!actionableCodeReview(status)) return false;
  const progress = codeReviewLabelProgress(status);
  return !progress.complete &&
    status.decision?.choice !== "ignore" &&
    !(status.decision?.choice === "accept" && progress.total === 0);
}

export function codeReviewFollowUpText(
  spec: CodeReviewSpec,
  status: CodeReviewStatus,
): string {
  const identity = spec.pullRequest;
  const result = status.result;
  if (!result) {
    throw new Error("CodeReview is missing its result");
  }
  const subject = `${identity.path} PR/MR ${identity.number}`;
  const outcomes = [
    result.findingCount
      ? `${result.findingCount} review finding(s)`
      : undefined,
    result.failedFileCount
      ? `${result.failedFileCount} file(s) failed review`
      : undefined,
  ].filter((item): item is string => Boolean(item));
  const lines = [
    `devloop review completed for ${subject}: ${outcomes.join(", ")}.`,
    "Evaluate the review comments against the current code. Fix the real findings, explain any false positives, and run the relevant lint and tests.",
    "Use the devloop label-review workflow to mark every published finding thread with ccr:label=important, minor, debatable, or wrong after checking the actual code.",
  ];
  for (const finding of result.findings.slice(0, 30)) {
    const detail = finding.message.replace(/\s+/g, " ").slice(0, 300);
    lines.push(`- ${finding.path}${detail ? ` — ${detail}` : ""}`);
  }
  if (result.findings.length > 30) {
    lines.push(`- … ${result.findings.length - 30} more finding(s)`);
  }
  if (result.findings.length === 0 && result.publicationSummary) {
    lines.push("", result.publicationSummary.slice(0, 2_000));
  }
  return lines.join("\n");
}
