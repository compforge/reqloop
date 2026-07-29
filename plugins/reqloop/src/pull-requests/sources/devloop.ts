import {
  unwatchFile,
  watchFile,
} from "node:fs";

import type {
  PluginLogger,
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
  private readonly logger?: PluginLogger;
  private readonly reviewObservations?: () => Promise<
    readonly PullRequestReviewObservation[]
  >;
  private lastFailureKey?: string;
  private lastPullRequestKey?: string;

  constructor(
    private readonly cwd: string,
    options: {
      readonly logger?: PluginLogger;
      readonly path?: string;
      readonly watchIntervalMs?: number;
      readonly reviewObservations?: () => Promise<
        readonly PullRequestReviewObservation[]
      >;
    } = {},
  ) {
    this.path = options.path?.trim() || undefined;
    this.watchIntervalMs = options.watchIntervalMs ?? 1_000;
    this.logger = options.logger;
    this.reviewObservations = options.reviewObservations;
  }

  async start(context: SourceContext<PullRequestSpec>): Promise<void> {
    const reviewObservations = await this.reviewObservations?.() ?? [];
    for (const observation of reviewObservations) {
      if (context.signal.aborted) return;
      await this.emit(context, observation.identity);
    }
    this.logger?.write({
      level: "info",
      component: "pull-request-source.devloop",
      message: "Loaded devloop review observations",
      details: {
        observations: reviewObservations.length,
        pullRequests: reviewObservations.map(({ identity }) =>
          `${identity.source}/${identity.repository}#${identity.number}`
        ).sort().join(",") || null,
      },
    });
    const path = this.path ?? await devloopStatePath(this.cwd, "pr.json");
    if (!path) {
      this.logger?.write({
        level: "info",
        component: "pull-request-source.devloop",
        message: "Devloop PR state is unavailable for this workspace root",
        details: { cwd: this.cwd },
      });
      return;
    }
    this.logger?.write({
      level: "info",
      component: "pull-request-source.devloop",
      message: "Watching devloop PR state",
      details: { path },
    });
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
    const pullRequestKey = JSON.stringify(numbers);
    if (pullRequestKey !== this.lastPullRequestKey) {
      this.lastPullRequestKey = pullRequestKey;
      this.logger?.write({
        level: "info",
        component: "pull-request-source.devloop",
        message: "Observed open PullRequests in devloop state",
        details: {
          openPullRequests: numbers.length,
          pullRequests: numbers.join(",") || null,
          path,
        },
      });
    }

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
