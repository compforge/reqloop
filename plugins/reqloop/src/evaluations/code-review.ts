import type {
  CodeReviewObservation,
  CodeReviewEvaluationSpec,
  EvaluationStatus,
} from "./protocol.ts";
import type { ForgeComment } from "../pull-requests/protocol.ts";

export const CODE_REVIEW_ACTIVE_TTL_MS = 24 * 60 * 60_000;

const SUMMARY_RE =
  /^🤖 \*\*devloop code-review\*\* · `([^`]+)` · `([0-9a-f]+)`/im;
const FINDING_COUNT_RE = /\*\*(\d+) finding\(s\)\*\*/i;
const FAILED_COUNT_RE = /(\d+) 个文件未能 review/i;
const FINGERPRINT_RE = /ccr:fp=([A-Za-z0-9_-]+)/;

export function codeReviewExpiresAt(
  observation: CodeReviewObservation,
  ttlMs: number = CODE_REVIEW_ACTIVE_TTL_MS,
): number {
  return Date.parse(observation.completedAt) + ttlMs;
}

function summary(
  comment: ForgeComment,
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
  comment: ForgeComment,
): CodeReviewObservation["findings"][number] | undefined {
  if (!comment.threadId || comment.replyTo) return;
  const fingerprint = FINGERPRINT_RE.exec(comment.body)?.[1];
  if (!fingerprint) return;
  const message = comment.body
    .replace(/^🤖 \*\*devloop code-review\*\*(?: · [^\n]+)?\s*/i, "")
    .replace(/\s*<sub>ccr:fp=[^<]+<\/sub>\s*$/i, "")
    .trim();
  return {
    path: comment.path ?? "?",
    message,
    fingerprint,
    commentId: comment.id,
    threadId: comment.threadId,
  };
}

function observationAt(
  pullRequest: CodeReviewObservation["pullRequest"],
  comments: readonly ForgeComment[],
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
  comments: readonly ForgeComment[],
): CodeReviewObservation | undefined {
  for (let index = comments.length - 1; index >= 0; index -= 1) {
    const observation = observationAt(pullRequest, comments, index);
    if (observation) return observation;
  }
}

export function codeReviewObservation(
  spec: CodeReviewEvaluationSpec,
  comments: readonly ForgeComment[],
): CodeReviewObservation | undefined {
  const index = comments.findIndex(({ id }) => id === spec.runKey);
  if (index < 0) return;
  return observationAt(spec.target.identity, comments, index);
}

export function codeReviewStatus(
  observation: CodeReviewObservation,
  ttlMs: number = CODE_REVIEW_ACTIVE_TTL_MS,
): EvaluationStatus {
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
      kind: "code-review",
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

export function actionableCodeReview(status: EvaluationStatus): boolean {
  return status.verdict === "failed" ||
    status.verdict === "action-required";
}

export function codeReviewFollowUpText(
  spec: CodeReviewEvaluationSpec,
  status: EvaluationStatus,
): string {
  const identity = spec.target.identity;
  const result = status.result;
  if (!result) {
    throw new Error("Code review Evaluation is missing its result");
  }
  const subject = `${identity.repository} PR/MR ${identity.number}`;
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
