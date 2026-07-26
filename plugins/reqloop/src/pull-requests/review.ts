import type { PullRequestReviewObservation } from "./protocol.ts";

export function actionableReview(
  observation: PullRequestReviewObservation,
): boolean {
  return (
    observation.count > 0 ||
    observation.failed > 0 ||
    observation.status === "error"
  );
}

export function reviewFollowUpText(
  observation: PullRequestReviewObservation,
): string {
  const subject = `${observation.identity.repository} PR/MR ` +
    `${observation.identity.number}`;
  const outcomes = [
    observation.count
      ? `${observation.count} review finding(s)`
      : undefined,
    observation.failed
      ? `${observation.failed} file(s) failed review`
      : undefined,
    observation.status === "error" ? "the review errored" : undefined,
  ].filter((item): item is string => Boolean(item));
  const lines = [
    `devloop review completed for ${subject}: ${outcomes.join(", ")}.`,
    "Evaluate the review comments against the current code. Fix the real findings, explain any false positives, and run the relevant lint and tests.",
  ];
  for (const finding of observation.findings.slice(0, 30)) {
    const detail = finding.message.replace(/\s+/g, " ").slice(0, 300);
    lines.push(`- ${finding.path}${detail ? ` — ${detail}` : ""}`);
  }
  if (observation.findings.length > 30) {
    lines.push(`- … ${observation.findings.length - 30} more finding(s)`);
  }
  return lines.join("\n");
}
