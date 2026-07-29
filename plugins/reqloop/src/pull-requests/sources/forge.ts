import type {
  Source,
  SourceContext,
} from "@compforge/baton-plugin";

import { discoverWorkspaceRepositories } from "../../workspaces/discovery.ts";
import type {
  ForgeConnector,
  PullRequestIdentity,
  PullRequestSpec,
} from "../protocol.ts";
import { pullRequestResourceId } from "../resource.ts";

const DEFAULT_MAX_PER_REPOSITORY = 5;
const DEFAULT_MAX_RESOURCES = 20;
const DEFAULT_RESYNC_INTERVAL_MS = 30_000;

interface ForgePullRequestSourceOptions {
  readonly maxPerRepository?: number;
  readonly maxResources?: number;
  readonly resyncIntervalMs?: number;
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
  private readonly failureKeys = new Map<string, string>();
  private refreshing?: Promise<void>;

  constructor(
    private readonly root: string,
    connectors: readonly ForgeConnector[],
    options: ForgePullRequestSourceOptions = {},
  ) {
    for (const connector of connectors) {
      if (this.connectors.has(connector.source)) {
        throw new Error(`duplicate ForgeConnector source: ${connector.source}`);
      }
      this.connectors.set(connector.source, connector);
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
    const batches = await Promise.all(checkouts.map(async ({ identity }) => {
      const connector = this.connectors.get(identity.source);
      if (!connector) return [];
      try {
        const pullRequests = await connector.list(identity.repository, {
          state: "open",
          limit: this.maxPerRepository,
        });
        this.failureKeys.delete(
          `${identity.source}/${identity.repository}`,
        );
        return pullRequests.map((pullRequest) => {
          this.assertWithinRepository(pullRequest, identity);
          return pullRequest;
        });
      } catch (error) {
        this.reportFailure(context, identity, error);
        return [];
      }
    }));

    for (const identity of batches.flat().slice(0, this.maxResources)) {
      if (context.signal.aborted) return;
      await context.emit({
        name: pullRequestResourceId(identity),
        spec: { identity },
      });
    }
  }

  private assertWithinRepository(
    pullRequest: PullRequestIdentity,
    repository: { readonly source: string; readonly repository: string },
  ): void {
    if (
      pullRequest.source !== repository.source ||
      pullRequest.repository !== repository.repository
    ) {
      throw new Error(
        "ForgeConnector listed a PullRequest outside the requested repository",
      );
    }
  }

  private reportFailure(
    context: SourceContext<PullRequestSpec>,
    repository: { readonly source: string; readonly repository: string },
    error: unknown,
  ): void {
    const repositoryKey = `${repository.source}/${repository.repository}`;
    const key = error instanceof Error
      ? `${error.name}:${error.message}`
      : String(error);
    if (this.failureKeys.get(repositoryKey) === key) return;
    this.failureKeys.set(repositoryKey, key);
    context.reportError(new Error(
      `Could not list Forge PullRequests for ${repository.repository}`,
      { cause: error },
    ));
  }
}
