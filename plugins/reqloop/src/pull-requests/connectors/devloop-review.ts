import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import type {
  PullRequestIdentity,
  PullRequestReviewFinding,
  PullRequestReviewConnector,
  PullRequestReviewObservation,
} from "../protocol.ts";
import { devloopStatePath } from "../devloop-state.ts";

interface ReviewHistoryRecord {
  readonly status?: unknown;
  readonly sha?: unknown;
  readonly count?: unknown;
  readonly failed?: unknown;
  readonly findings?: unknown;
  readonly pull_request?: unknown;
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

function reviewFinding(
  value: unknown,
): PullRequestReviewFinding | undefined {
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

function pullRequestIdentity(
  value: unknown,
): PullRequestIdentity | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const identity = value as Record<string, unknown>;
  if (
    typeof identity.source !== "string" ||
    !identity.source.trim() ||
    typeof identity.repository !== "string" ||
    !identity.repository.trim() ||
    !Number.isSafeInteger(identity.number) ||
    (identity.number as number) < 1
  ) {
    return;
  }
  return Object.freeze({
    source: identity.source.trim(),
    repository: identity.repository.trim(),
    number: identity.number as number,
  });
}

function parseHistoryLine(
  line: string,
): PullRequestReviewObservation | undefined {
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
  const identity = pullRequestIdentity(record.pull_request);
  if (!identity) return;
  const findings = Array.isArray(record.findings)
    ? record.findings.flatMap((item) => {
        const finding = reviewFinding(item);
        return finding ? [finding] : [];
      })
    : [];
  return Object.freeze({
    identity,
    key: sha256(line),
    status: record.status,
    sha: record.sha,
    count: nonNegativeInteger(record.count),
    failed: nonNegativeInteger(record.failed),
    findings: Object.freeze(findings),
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
 * devloop 是 review 事实的 producer；reqloop 只读取其 append-only ledger，并映射为
 * 已绑定 PullRequest 的 review observation。
 */
export class DevloopReviewConnector implements PullRequestReviewConnector {
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
    this.historyPath =
      explicit ||
      devloopStatePath(cwd, "review-history.jsonl");
    this.checkout = options.checkout ?? (() => gitCheckout(cwd));
  }

  latest(): PullRequestReviewObservation | undefined {
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
