import type {
  PluginLogger,
  Source,
  SourceContext,
} from "@compforge/baton-plugin";

import { discoverWorkspaceRepositories } from "../../workspaces/discovery.ts";
import type { WorkspaceRepositoryCheckout } from "../../workspaces/discovery.ts";
import type { RepositoryIdentity } from "../../repositories/protocol.ts";
import type {
  ForgeConnector,
  PullRequestIdentity,
  PullRequestSpec,
} from "../protocol.ts";
import { isForgeRateLimitError } from "../protocol.ts";
import { pullRequestResourceId } from "../resource.ts";

const DEFAULT_MAX_PER_REPOSITORY = 5;
const DEFAULT_MAX_RESOURCES = 20;
const DEFAULT_RESYNC_INTERVAL_MS = 30_000;

interface ForgePullRequestSourceOptions {
  readonly logger?: PluginLogger;
  readonly maxPerRepository?: number;
  readonly maxResources?: number;
  readonly resyncIntervalMs?: number;
  readonly shouldTrack?: (
    checkout: WorkspaceRepositoryCheckout,
  ) => Promise<boolean>;
}

function positiveInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

/**
 * Uses Forge read capabilities to admit a small, recent set of open PRs.
 *
 * DevloopPullRequestSource may emit the same stable identity sooner; repeated
 * observations converge through Baton's Source ensure semantics.
 */
export class ForgePullRequestSource implements Source<PullRequestSpec> {
  readonly type = "resource";
  readonly sourceId = "forge";
  private readonly connectors = new Map<string, ForgeConnector>();
  private readonly maxPerRepository: number;
  private readonly maxResources: number;
  private readonly resyncIntervalMs: number;
  private readonly logger?: PluginLogger;
  private readonly shouldTrack: (
    checkout: WorkspaceRepositoryCheckout,
  ) => Promise<boolean>;
  private readonly failureKeys = new Map<string, string>();
  private lastScopeKey?: string;
  private lastResultKey?: string;
  private refreshing?: Promise<void>;

  constructor(
    private readonly root: string,
    connectors: readonly ForgeConnector[],
    options: ForgePullRequestSourceOptions = {},
  ) {
    for (const connector of connectors) {
      if (this.connectors.has(connector.forge)) {
        throw new Error(`duplicate ForgeConnector: ${connector.forge}`);
      }
      this.connectors.set(connector.forge, connector);
    }
    this.maxPerRepository = positiveInteger(
      "ForgePullRequestSource maxPerRepository",
      options.maxPerRepository ?? DEFAULT_MAX_PER_REPOSITORY,
    );
    this.maxResources = positiveInteger(
      "ForgePullRequestSource maxResources",
      options.maxResources ?? DEFAULT_MAX_RESOURCES,
    );
    this.resyncIntervalMs = positiveInteger(
      "ForgePullRequestSource resyncIntervalMs",
      options.resyncIntervalMs ?? DEFAULT_RESYNC_INTERVAL_MS,
    );
    this.logger = options.logger;
    this.shouldTrack = options.shouldTrack ?? (async () => true);
  }

  async start(context: SourceContext<PullRequestSpec>): Promise<void> {
    await this.runRefresh(context);
    if (context.signal.aborted) return;
    const timer = setInterval(() => {
      void this.runRefresh(context).catch(context.reportError);
    }, this.resyncIntervalMs);
    context.signal.addEventListener(
      "abort",
      () => clearInterval(timer),
      { once: true },
    );
  }

  private async runRefresh(
    context: SourceContext<PullRequestSpec>,
  ): Promise<void> {
    if (this.refreshing) return await this.refreshing;
    const refreshing = this.refresh(context);
    this.refreshing = refreshing;
    try {
      await refreshing;
    } finally {
      if (this.refreshing === refreshing) this.refreshing = undefined;
    }
  }

  private async refresh(
    context: SourceContext<PullRequestSpec>,
  ): Promise<void> {
    const checkouts = await discoverWorkspaceRepositories(this.root);
    const tracked: {
      readonly checkout: WorkspaceRepositoryCheckout;
      readonly connector: ForgeConnector;
    }[] = [];
    let skippedByActivity = 0;
    let skippedWithoutConnector = 0;
    for (const checkout of checkouts) {
      if (context.signal.aborted) return;
      if (!(await this.shouldTrack(checkout))) {
        skippedByActivity += 1;
        continue;
      }
      const connector = this.connectors.get(checkout.identity.forge);
      if (!connector) {
        skippedWithoutConnector += 1;
        continue;
      }
      tracked.push({ checkout, connector });
    }
    this.logScope(
      checkouts.length,
      tracked.map(({ checkout }) => checkout),
      skippedByActivity,
      skippedWithoutConnector,
    );

    const pullRequests: PullRequestIdentity[] = [];
    const rateLimitedForges = new Set<string>();
    let listedRepositories = 0;
    let failedRepositories = 0;
    let skippedAfterRateLimit = 0;
    for (const { checkout, connector } of tracked) {
      if (context.signal.aborted) return;
      const { identity } = checkout;
      if (rateLimitedForges.has(identity.forge)) {
        skippedAfterRateLimit += 1;
        continue;
      }
      try {
        const observations = await connector.list(identity.path, {
          state: "open",
          limit: this.maxPerRepository,
        });
        listedRepositories += 1;
        this.failureKeys.delete(
          `${identity.forge}/${identity.path}`,
        );
        pullRequests.push(...observations.map((pullRequest) => {
          this.assertWithinRepository(pullRequest, identity);
          return pullRequest;
        }));
      } catch (error) {
        failedRepositories += 1;
        this.reportFailure(context, identity, error);
        if (isForgeRateLimitError(error)) {
          rateLimitedForges.add(identity.forge);
        }
      }
    }

    const admitted = pullRequests.slice(0, this.maxResources);
    for (const identity of admitted) {
      if (context.signal.aborted) return;
      await context.emit({
        name: pullRequestResourceId(identity),
        spec: { identity },
      });
    }
    this.logResult({
      admitted,
      discovered: pullRequests.length,
      failedRepositories,
      listedRepositories,
      skippedAfterRateLimit,
    });
  }

  private logScope(
    checkoutCount: number,
    tracked: readonly WorkspaceRepositoryCheckout[],
    skippedByActivity: number,
    skippedWithoutConnector: number,
  ): void {
    const repositories = tracked.map(({ identity }) =>
      `${identity.forge}/${identity.path}`
    ).sort();
    const key = JSON.stringify([
      checkoutCount,
      repositories,
      skippedByActivity,
      skippedWithoutConnector,
    ]);
    if (key === this.lastScopeKey) return;
    this.lastScopeKey = key;
    this.logger?.debug("Forge PullRequest discovery scope updated", {
      component: "pull-request-source.forge",
      attributes: {
        discoveredCheckouts: checkoutCount,
        trackedRepositories: tracked.length,
        skippedByActivity,
        skippedWithoutConnector,
        repositories,
      },
    });
  }

  private logResult(result: {
    readonly admitted: readonly PullRequestIdentity[];
    readonly discovered: number;
    readonly failedRepositories: number;
    readonly listedRepositories: number;
    readonly skippedAfterRateLimit: number;
  }): void {
    const pullRequests = result.admitted.map((identity) =>
      `${identity.forge}/${identity.path}#${identity.number}`
    ).sort();
    const key = JSON.stringify([
      pullRequests,
      result.discovered,
      result.failedRepositories,
      result.listedRepositories,
      result.skippedAfterRateLimit,
    ]);
    if (key === this.lastResultKey) return;
    this.lastResultKey = key;
    this.logger?.info("Forge PullRequest discovery completed", {
      component: "pull-request-source.forge",
      attributes: {
        listedRepositories: result.listedRepositories,
        failedRepositories: result.failedRepositories,
        skippedAfterRateLimit: result.skippedAfterRateLimit,
        discoveredPullRequests: result.discovered,
        admittedPullRequests: result.admitted.length,
      },
    });
    this.logger?.debug("Discovered Forge PullRequests", {
      component: "pull-request-source.forge",
      attributes: {
        pullRequests,
      },
    });
  }

  private assertWithinRepository(
    pullRequest: PullRequestIdentity,
    repository: RepositoryIdentity,
  ): void {
    if (
      pullRequest.forge !== repository.forge ||
      pullRequest.path !== repository.path
    ) {
      throw new Error(
        "ForgeConnector listed a PullRequest outside the requested repository",
      );
    }
  }

  private reportFailure(
    context: SourceContext<PullRequestSpec>,
    repository: RepositoryIdentity,
    error: unknown,
  ): void {
    const repositoryKey = `${repository.forge}/${repository.path}`;
    const key = error instanceof Error
      ? `${error.name}:${error.message}`
      : String(error);
    if (this.failureKeys.get(repositoryKey) === key) return;
    this.failureKeys.set(repositoryKey, key);
    this.logger?.warn("Could not list Forge PullRequests", {
      component: "pull-request-source.forge",
      error,
      attributes: { repository: repositoryKey },
    });
    context.reportError(new Error(
      `Could not list Forge PullRequests for ${repository.path}`,
      { cause: error },
    ));
  }
}
