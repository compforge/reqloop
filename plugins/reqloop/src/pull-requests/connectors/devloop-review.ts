import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import type {
  PullRequestIdentity,
  PullRequestReviewFinding,
  PullRequestReviewConnector,
  PullRequestReviewObservation,
} from "../protocol.ts";
import { gitOutput } from "../../git-command.ts";
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

export interface PullRequestReviewCheckout {
  readonly path: string;
  readonly source?: string;
  readonly repository?: string;
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

async function gitCheckout(
  cwd: string,
): Promise<CheckoutIdentity | undefined> {
  const headSha = await gitOutput(cwd, ["rev-parse", "HEAD"]);
  if (!headSha) return;
  const branch = await gitOutput(cwd, ["branch", "--show-current"]);
  return Object.freeze({
    headSha,
    ...(branch ? { branch } : {}),
  });
}

function sameIdentity(
  left: PullRequestIdentity,
  right: PullRequestIdentity,
): boolean {
  return (
    left.source === right.source &&
    left.repository === right.repository &&
    left.number === right.number
  );
}

/**
 * devloop 是 review 事实的 producer；reqloop 只读取其 append-only ledger，并映射为
 * 已绑定 PullRequest 的 review observation。
 */
export class DevloopReviewConnector implements PullRequestReviewConnector {
  readonly historyPath?: string;
  private readonly explicitHistoryPath?: string;
  private readonly rootCheckout?:
    () => Promise<CheckoutIdentity | undefined> | CheckoutIdentity | undefined;
  private readonly workspaceCheckouts:
    () =>
      | Promise<readonly PullRequestReviewCheckout[]>
      | readonly PullRequestReviewCheckout[];

  constructor(
    private readonly root: string,
    options: {
      historyPath?: string;
      checkout?:
        () => Promise<CheckoutIdentity | undefined> | CheckoutIdentity | undefined;
      workspaceCheckouts?:
        () =>
          | Promise<readonly PullRequestReviewCheckout[]>
          | readonly PullRequestReviewCheckout[];
    } = {},
  ) {
    const explicit = options.historyPath?.trim();
    this.explicitHistoryPath = explicit || undefined;
    this.historyPath = explicit || undefined;
    this.rootCheckout = options.checkout;
    this.workspaceCheckouts = options.workspaceCheckouts ??
      (() => [{ path: root }]);
  }

  async listLatest(): Promise<readonly PullRequestReviewObservation[]> {
    const observations: PullRequestReviewObservation[] = [];
    for (const checkout of await this.reviewCheckouts()) {
      const observation = await this.latestForCheckout(checkout.path);
      if (observation) observations.push(observation);
    }
    return observations;
  }

  async latest(
    identity: PullRequestIdentity,
  ): Promise<PullRequestReviewObservation | undefined> {
    for (const checkout of await this.reviewCheckouts()) {
      if (
        checkout.source !== undefined &&
        (checkout.source !== identity.source ||
          checkout.repository !== identity.repository)
      ) {
        continue;
      }
      const observation = await this.latestForCheckout(checkout.path);
      if (observation && sameIdentity(observation.identity, identity)) {
        return observation;
      }
    }
  }

  private async reviewCheckouts(): Promise<
    readonly PullRequestReviewCheckout[]
  > {
    const checkouts = this.explicitHistoryPath
      ? [{ path: this.root }]
      : await this.workspaceCheckouts();
    const unique = new Map<string, PullRequestReviewCheckout>();
    for (const checkout of checkouts) {
      if (!unique.has(checkout.path)) unique.set(checkout.path, checkout);
    }
    return [...unique.values()];
  }

  private async latestForCheckout(
    checkoutRoot: string,
  ): Promise<PullRequestReviewObservation | undefined> {
    const historyPath = checkoutRoot === this.root
      ? this.historyPath ??
        await devloopStatePath(checkoutRoot, "review-history.jsonl")
      : await devloopStatePath(checkoutRoot, "review-history.jsonl");
    const checkout = checkoutRoot === this.root && this.rootCheckout
      ? this.rootCheckout
      : () => gitCheckout(checkoutRoot);
    if (!historyPath || !existsSync(historyPath)) return;
    let lines: string[];
    try {
      lines = readFileSync(historyPath, "utf8").split(/\r?\n/);
    } catch {
      return;
    }
    const current = await checkout();
    if (!current) return;
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index]?.trim();
      if (!line) continue;
      const observation = parseHistoryLine(line);
      if (!observation) continue;
      if (
        observation.sha !== current.headSha ||
        (observation.branch !== undefined &&
          observation.branch !== current.branch)
      ) {
        continue;
      }
      return observation;
    }
  }
}
