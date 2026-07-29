import {
  unwatchFile,
  watchFile,
} from "node:fs";

import type {
  Source,
  SourceContext,
} from "@compforge/baton-plugin";

import { devloopStatePath } from "../pull-requests/devloop-state.ts";
import { workspaceCandidates } from "./discovery.ts";
import type { WorkspaceSpec } from "./protocol.ts";
import {
  WORKSPACE_RESOURCE_NAME,
  workspaceSpec,
} from "./resource.ts";

export class WorkspaceSource implements Source<WorkspaceSpec> {
  readonly type = "resource";
  readonly sourceId = "workspace-filesystem";
  private readonly watchIntervalMs: number;
  private readonly watchers = new Map<string, () => void>();
  private lastFailureKey?: string;

  constructor(
    private readonly root: string,
    options: {
      readonly watchIntervalMs?: number;
    } = {},
  ) {
    this.watchIntervalMs = options.watchIntervalMs ?? 1_000;
  }

  async start(context: SourceContext<WorkspaceSpec>): Promise<void> {
    if (context.signal.aborted) return;
    const onChange = (): void => {
      void this.refresh(context, onChange).catch(context.reportError);
    };
    context.signal.addEventListener(
      "abort",
      () => this.stop(onChange),
      { once: true },
    );
    await this.refresh(context, onChange);
  }

  private async refresh(
    context: SourceContext<WorkspaceSpec>,
    onChange: () => void,
  ): Promise<void> {
    try {
      await this.syncWatchers(onChange);
      this.lastFailureKey = undefined;
    } catch (error) {
      const key = errorKey(error);
      if (this.lastFailureKey !== key) {
        this.lastFailureKey = key;
        context.reportError(new Error(
          `Could not watch reqloop workspace: ${this.root}`,
          { cause: error },
        ));
      }
    }
    await context.emit({
      name: WORKSPACE_RESOURCE_NAME,
      spec: workspaceSpec(),
    });
  }

  private async syncWatchers(onChange: () => void): Promise<void> {
    const targets = new Set<string>();
    for (const candidate of workspaceCandidates(this.root)) {
      targets.add(candidate.path);
      const pullRequestState = await devloopStatePath(
        candidate.path,
        "pr.json",
      );
      if (pullRequestState) targets.add(pullRequestState);
    }

    for (const path of this.watchers.keys()) {
      if (targets.has(path)) continue;
      unwatchFile(path, onChange);
      this.watchers.delete(path);
    }
    for (const path of targets) {
      if (this.watchers.has(path)) continue;
      watchFile(path, {
        interval: this.watchIntervalMs,
        persistent: false,
      }, onChange);
      this.watchers.set(path, onChange);
    }
  }

  private stop(onChange: () => void): void {
    for (const path of this.watchers.keys()) {
      unwatchFile(path, onChange);
    }
    this.watchers.clear();
  }
}

function errorKey(error: unknown): string {
  return error instanceof Error
    ? `${error.name}:${error.message}`
    : String(error);
}
