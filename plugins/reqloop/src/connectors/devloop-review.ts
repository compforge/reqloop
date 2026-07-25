import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface DevloopReviewFinding {
  readonly path: string;
  readonly message: string;
  readonly status?: string;
}

export interface DevloopReviewObservation {
  readonly key: string;
  readonly status: string;
  readonly sha: string;
  readonly count: number;
  readonly failed: number;
  readonly findings: readonly DevloopReviewFinding[];
  readonly prNumber?: string | number;
  readonly reviewedRange?: string;
  readonly posted?: string;
  readonly completedAt?: number;
  readonly branch?: string;
}

interface ReviewHistoryRecord {
  readonly status?: unknown;
  readonly sha?: unknown;
  readonly count?: unknown;
  readonly failed?: unknown;
  readonly findings?: unknown;
  readonly pr_number?: unknown;
  readonly range?: unknown;
  readonly posted?: unknown;
  readonly ts?: unknown;
  readonly branch?: unknown;
}

interface CheckoutIdentity {
  readonly headSha: string;
  readonly branch?: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function nonNegativeInteger(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? (value as number)
    : 0;
}

function reviewFinding(value: unknown): DevloopReviewFinding | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const finding = value as Record<string, unknown>;
  const path = typeof finding.path === "string" ? finding.path : "";
  const message = typeof finding.msg === "string" ? finding.msg.trim() : "";
  if (!path && !message) return;
  return Object.freeze({
    path: path || "?",
    message,
    ...(typeof finding.status === "string"
      ? { status: finding.status }
      : {}),
  });
}

function parseHistoryLine(
  line: string,
): DevloopReviewObservation | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch {
    return;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const record = value as ReviewHistoryRecord;
  if (typeof record.status !== "string" || typeof record.sha !== "string") {
    return;
  }
  const findings = Array.isArray(record.findings)
    ? record.findings.flatMap((item) => {
        const finding = reviewFinding(item);
        return finding ? [finding] : [];
      })
    : [];
  return Object.freeze({
    key: sha256(line),
    status: record.status,
    sha: record.sha,
    count: nonNegativeInteger(record.count),
    failed: nonNegativeInteger(record.failed),
    findings: Object.freeze(findings),
    ...(typeof record.pr_number === "string" ||
    typeof record.pr_number === "number"
      ? { prNumber: record.pr_number }
      : {}),
    ...(typeof record.range === "string"
      ? { reviewedRange: record.range }
      : {}),
    ...(typeof record.posted === "string" ? { posted: record.posted } : {}),
    ...(typeof record.ts === "number" && Number.isFinite(record.ts)
      ? { completedAt: record.ts }
      : {}),
    ...(typeof record.branch === "string" ? { branch: record.branch } : {}),
  });
}

function gitOutput(cwd: string, args: readonly string[]): string | undefined {
  let result: ReturnType<typeof Bun.spawnSync>;
  try {
    result = Bun.spawnSync(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 2_000,
    });
  } catch {
    return;
  }
  if (result.exitCode !== 0) return;
  const output = result.stdout?.toString().trim();
  return output || undefined;
}

function gitCommonRoot(cwd: string): string | undefined {
  const commonDir = gitOutput(cwd, ["rev-parse", "--git-common-dir"]);
  if (!commonDir) return;
  return dirname(resolve(cwd, commonDir));
}

function gitCheckout(cwd: string): CheckoutIdentity | undefined {
  const headSha = gitOutput(cwd, ["rev-parse", "HEAD"]);
  if (!headSha) return;
  const branch = gitOutput(cwd, ["branch", "--show-current"]);
  return Object.freeze({
    headSha,
    ...(branch ? { branch } : {}),
  });
}

/**
 * devloop 是 review 事实的 producer；reqloop 只读取其 append-only ledger，并在本域内
 * 映射成 Verdict observation。
 */
export class DevloopReviewConnector {
  readonly historyPath?: string;
  private readonly checkout: () => CheckoutIdentity | undefined;

  constructor(
    cwd: string,
    options: {
      historyPath?: string;
      checkout?: () => CheckoutIdentity | undefined;
    } = {},
  ) {
    const explicit = options.historyPath?.trim();
    const repoRoot = explicit ? undefined : gitCommonRoot(cwd);
    this.historyPath =
      explicit ||
      (repoRoot
        ? join(repoRoot, ".devloop", "review-history.jsonl")
        : undefined);
    this.checkout = options.checkout ?? (() => gitCheckout(cwd));
  }

  latest(): DevloopReviewObservation | undefined {
    if (!this.historyPath || !existsSync(this.historyPath)) return;
    let lines: string[];
    try {
      lines = readFileSync(this.historyPath, "utf8").split(/\r?\n/);
    } catch {
      return;
    }
    const checkout = this.checkout();
    if (!checkout) return;
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index]?.trim();
      if (!line) continue;
      const observation = parseHistoryLine(line);
      if (!observation) continue;
      if (
        observation.sha !== checkout.headSha ||
        (observation.branch !== undefined &&
          observation.branch !== checkout.branch)
      ) {
        continue;
      }
      return observation;
    }
  }
}

export function actionableReview(
  observation: DevloopReviewObservation,
): boolean {
  return (
    observation.count > 0 ||
    observation.failed > 0 ||
    observation.status === "error"
  );
}

export function reviewFollowUpText(
  observation: DevloopReviewObservation,
): string {
  const subject = observation.prNumber
    ? `PR/MR ${observation.prNumber}`
    : `commit ${observation.sha.slice(0, 9)}`;
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
    "Inspect the review comments against the current code now. Briefly report the real High/Medium findings and explain false positives; do not modify code unless the user asks.",
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
