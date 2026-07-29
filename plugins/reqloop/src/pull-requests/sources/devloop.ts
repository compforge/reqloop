import {
  unwatchFile,
  watchFile,
} from "node:fs";

import type {
  Source,
  SourceContext,
} from "@compforge/baton-plugin";

import {
  currentRepositoryIdentity,
} from "../../repositories/identity.ts";
import {
  devloopStatePath,
  readOpenPullRequestNumbers,
} from "../devloop-state.ts";
import type {
  PullRequestReviewObservation,
  PullRequestSpec,
} from "../protocol.ts";
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
  private readonly reviewObservations?: () => Promise<
    readonly PullRequestReviewObservation[]
  >;
  private lastFailureKey?: string;

  constructor(
    private readonly cwd: string,
    options: {
      readonly path?: string;
      readonly watchIntervalMs?: number;
      readonly reviewObservations?: () => Promise<
        readonly PullRequestReviewObservation[]
      >;
    } = {},
  ) {
    this.path = options.path?.trim() || undefined;
    this.watchIntervalMs = options.watchIntervalMs ?? 1_000;
    this.reviewObservations = options.reviewObservations;
  }

  async start(context: SourceContext<PullRequestSpec>): Promise<void> {
    for (const observation of await this.reviewObservations?.() ?? []) {
      if (context.signal.aborted) return;
      await this.emit(context, observation.identity);
    }
    const path = this.path ?? await devloopStatePath(this.cwd, "pr.json");
    if (!path) return;
    const listener = (): void => {
      void this.emitCurrent(context, path).catch((error) =>
        this.reportFailure(context, errorKey(error), error, path)
      );
    };
    watchFile(path, {
      interval: this.watchIntervalMs,
      persistent: false,
    }, listener);
    context.signal.addEventListener(
      "abort",
      () => unwatchFile(path, listener),
      { once: true },
    );
    await this.emitCurrent(context, path);
  }

  private async emitCurrent(
    context: SourceContext<PullRequestSpec>,
    path: string,
  ): Promise<void> {
    const repository = await currentRepositoryIdentity(this.cwd);
    if (!repository) {
      this.lastFailureKey = undefined;
      return;
    }

    let numbers: readonly number[];
    try {
      numbers = readOpenPullRequestNumbers(path);
    } catch (error) {
      this.reportFailure(
        context,
        errorKey(error),
        error,
        path,
      );
      return;
    }
    this.lastFailureKey = undefined;

    for (const number of numbers) {
      const identity = { ...repository, number };
      await this.emit(context, identity);
    }
  }

  private async emit(
    context: SourceContext<PullRequestSpec>,
    identity: PullRequestSpec["identity"],
  ): Promise<void> {
    await context.emit({
      name: pullRequestResourceId(identity),
      spec: { identity },
    });
  }

  private reportFailure(
    context: SourceContext<PullRequestSpec>,
    key: string,
    error: unknown,
    path: string,
  ): void {
    if (this.lastFailureKey === key) return;
    this.lastFailureKey = key;
    context.reportError(
      error instanceof Error
        ? error
        : new Error(`Could not read devloop PR state: ${path}`, {
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
