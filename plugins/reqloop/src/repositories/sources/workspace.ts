import type {
  Source,
  SourceContext,
} from "@compforge/baton-plugin";

import { discoverWorkspaceRepositories } from "../../workspaces/discovery.ts";
import type { RepositorySpec } from "../protocol.ts";
import { repositoryResourceName } from "../resource.ts";

const DEFAULT_RESYNC_INTERVAL_MS = 30_000;

/**
 * Admits bounded Workspace checkouts as Repository Resources.
 *
 * The Connector remains an external protocol adapter; this Source owns the
 * decision to materialize the provider-neutral repository identity.
 */
export class WorkspaceRepositorySource implements Source<RepositorySpec> {
  readonly type = "resource";
  readonly sourceId = "workspace";
  private readonly resyncIntervalMs: number;
  private refreshing?: Promise<void>;

  constructor(
    private readonly root: string,
    options: {
      readonly resyncIntervalMs?: number;
    } = {},
  ) {
    this.resyncIntervalMs =
      options.resyncIntervalMs ?? DEFAULT_RESYNC_INTERVAL_MS;
    if (
      !Number.isSafeInteger(this.resyncIntervalMs) ||
      this.resyncIntervalMs < 1
    ) {
      throw new Error(
        "WorkspaceRepositorySource resyncIntervalMs must be a positive integer",
      );
    }
  }

  async start(context: SourceContext<RepositorySpec>): Promise<void> {
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
    context: SourceContext<RepositorySpec>,
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
    context: SourceContext<RepositorySpec>,
  ): Promise<void> {
    for (const { identity } of await discoverWorkspaceRepositories(this.root)) {
      if (context.signal.aborted) return;
      await context.emit({
        name: repositoryResourceName(identity),
        spec: { identity },
      });
    }
  }
}
