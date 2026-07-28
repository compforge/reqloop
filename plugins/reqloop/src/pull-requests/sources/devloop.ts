import {
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
import {
  devloopStatePath,
  readOpenPullRequestNumbers,
} from "../devloop-state.ts";
import type { PullRequestSpec } from "../protocol.ts";
import { pullRequestResourceId } from "../resource.ts";

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
    if (!repository || !this.path) {
      this.lastFailureKey = undefined;
      return;
    }

    let numbers: readonly number[];
    try {
      numbers = readOpenPullRequestNumbers(this.path);
    } catch (error) {
      this.reportFailure(
        context,
        errorKey(error),
        error,
      );
      return;
    }
    this.lastFailureKey = undefined;

    for (const number of numbers) {
      const identity = { ...repository, number };
      context.emit({
        name: pullRequestResourceId(identity),
        spec: { identity },
      });
    }
  }

  private reportFailure(
    context: SourceContext<PullRequestSpec>,
    key: string,
    error: unknown,
  ): void {
    if (this.lastFailureKey === key) return;
    this.lastFailureKey = key;
    context.reportError(
      error instanceof Error
        ? error
        : new Error(`Could not read devloop PR state: ${this.path}`, {
          cause: error,
        }),
    );
  }
}

function errorKey(error: unknown): string {
  return error instanceof Error
    ? `${error.name}:${error.message}`
    : String(error);
}
