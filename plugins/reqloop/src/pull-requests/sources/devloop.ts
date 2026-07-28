import {
  existsSync,
  readFileSync,
  unwatchFile,
  watchFile,
} from "node:fs";

import type {
  Source,
  SourceContext,
} from "@qiankun01/baton-plugin";

import {
  currentRepositoryIdentity,
} from "../../repositories/identity.ts";
import { devloopStatePath } from "../devloop-state.ts";
import type {
  PullRequestIdentity,
  PullRequestSpec,
} from "../protocol.ts";
import { pullRequestResourceId } from "../resource.ts";

function openPullRequestNumber(value: unknown): number | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const pullRequest = value as Record<string, unknown>;
  if (
    pullRequest.state !== "open" ||
    !Number.isSafeInteger(pullRequest.number) ||
    (pullRequest.number as number) < 1
  ) {
    return;
  }
  return pullRequest.number as number;
}

/**
 * Contributes open PullRequest Resources from devloop's optional local cache.
 * Forge observation remains authoritative after a Resource is materialized.
 */
export class DevloopPullRequestSource implements Source<PullRequestSpec> {
  readonly type = "resource";
  readonly sourceId = "devloop";
  readonly path?: string;
  private readonly watchIntervalMs: number;
  private lastFailureKey?: string;

  constructor(
    private readonly cwd: string,
    options: {
      readonly path?: string;
      readonly watchIntervalMs?: number;
    } = {},
  ) {
    this.path = options.path?.trim() ||
      devloopStatePath(cwd, "pr.json");
    this.watchIntervalMs = options.watchIntervalMs ?? 1_000;
  }

  start(context: SourceContext<PullRequestSpec>): void {
    if (!this.path) return;
    const listener = (): void => this.emitCurrent(context);
    watchFile(this.path, {
      interval: this.watchIntervalMs,
      persistent: false,
    }, listener);
    context.signal.addEventListener(
      "abort",
      () => unwatchFile(this.path!, listener),
      { once: true },
    );
    this.emitCurrent(context);
  }

  private emitCurrent(context: SourceContext<PullRequestSpec>): void {
    const repository = currentRepositoryIdentity(this.cwd);
    if (!repository || !this.path || !existsSync(this.path)) {
      this.lastFailureKey = undefined;
      return;
    }

    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch (error) {
      this.reportFailure(
        context,
        `read:${errorKey(error)}`,
        "Could not read devloop PR state",
        error,
      );
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch (error) {
      this.reportFailure(
        context,
        `parse:${errorKey(error)}`,
        "Could not parse devloop PR state",
        error,
      );
      return;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      this.reportFailure(
        context,
        "shape:root",
        "Devloop PR state must be a JSON object",
      );
      return;
    }
    const records = (value as Record<string, unknown>).prs;
    if (!Array.isArray(records)) {
      this.reportFailure(
        context,
        "shape:prs",
        "Devloop PR state must contain a prs array",
      );
      return;
    }
    this.lastFailureKey = undefined;

    const identities = new Map<number, PullRequestIdentity>();
    for (const record of records) {
      const number = openPullRequestNumber(record);
      if (number !== undefined) {
        identities.set(number, { ...repository, number });
      }
    }
    for (const identity of identities.values()) {
      context.emit({
        name: pullRequestResourceId(identity),
        spec: { identity },
      });
    }
  }

  private reportFailure(
    context: SourceContext<PullRequestSpec>,
    key: string,
    message: string,
    cause?: unknown,
  ): void {
    if (this.lastFailureKey === key) return;
    this.lastFailureKey = key;
    context.reportError(new Error(
      `${message}: ${this.path}`,
      cause === undefined ? undefined : { cause },
    ));
  }
}

function errorKey(error: unknown): string {
  return error instanceof Error
    ? `${error.name}:${error.message}`
    : String(error);
}
