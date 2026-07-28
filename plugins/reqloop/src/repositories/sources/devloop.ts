import { existsSync, readFileSync } from "node:fs";
import type {
  PluginLogEntry,
  PluginLogger,
} from "@qiankun01/baton-plugin";

import { devloopStatePath } from "../../pull-requests/connectors/devloop-state.ts";
import type {
  PullRequestIdentity,
} from "../../pull-requests/protocol.ts";
import type {
  PullRequestDiscoverySource,
  RepositoryIdentity,
} from "../protocol.ts";

function sameRepository(
  left: RepositoryIdentity,
  right: RepositoryIdentity,
): boolean {
  return left.source === right.source &&
    left.repository === right.repository;
}

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
 * Reads devloop's optional PR cache without depending on devloop at runtime.
 * Missing, stale, or malformed state simply contributes no discoveries.
 */
export class DevloopPullRequestSource
  implements PullRequestDiscoverySource {
  readonly sourceId = "devloop";
  readonly path?: string;
  readonly repository: RepositoryIdentity;
  private readonly logger?: PluginLogger;
  private lastFailureKey?: string;

  constructor(
    cwd: string,
    repository: RepositoryIdentity,
    options: {
      readonly path?: string;
      readonly logger?: PluginLogger;
    } = {},
  ) {
    this.path = options.path?.trim() ||
      devloopStatePath(cwd, "pr.json");
    this.repository = repository;
    this.logger = options.logger;
  }

  discover(
    repository: RepositoryIdentity,
  ): readonly PullRequestIdentity[] {
    if (!sameRepository(this.repository, repository)) {
      return [];
    }
    if (!this.path) {
      this.reportFailure(
        "path-unavailable",
        "debug",
        "Devloop PR state path is unavailable",
      );
      return [];
    }
    if (!existsSync(this.path)) {
      this.reportFailure(
        `missing:${this.path}`,
        "debug",
        "Devloop PR state file is missing",
      );
      return [];
    }

    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch (error) {
      this.reportFailure(
        `read:${errorKey(error)}`,
        "warn",
        "Could not read devloop PR state",
        error,
      );
      return [];
    }
    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch (error) {
      this.reportFailure(
        `parse:${errorKey(error)}`,
        "warn",
        "Could not parse devloop PR state",
        error,
      );
      return [];
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      this.reportFailure(
        "shape:root",
        "warn",
        "Devloop PR state must be a JSON object",
      );
      return [];
    }
    const records = (value as Record<string, unknown>).prs;
    if (!Array.isArray(records)) {
      this.reportFailure(
        "shape:prs",
        "warn",
        "Devloop PR state must contain a prs array",
      );
      return [];
    }
    this.reportRecovery();

    const numbers = new Set<number>();
    for (const record of records) {
      const number = openPullRequestNumber(record);
      if (number !== undefined) numbers.add(number);
    }
    return Object.freeze(
      [...numbers].map((number) =>
        Object.freeze({ ...repository, number })
      ),
    );
  }

  private reportFailure(
    key: string,
    level: PluginLogEntry["level"],
    message: string,
    error?: unknown,
  ): void {
    if (this.lastFailureKey === key) return;
    this.lastFailureKey = key;
    this.writeLog({
      level,
      component: "devloop.pull-request-source",
      message,
      ...(error === undefined ? {} : { error }),
      ...(this.path ? { details: { path: this.path } } : {}),
    });
  }

  private reportRecovery(): void {
    if (!this.lastFailureKey) return;
    this.lastFailureKey = undefined;
    this.writeLog({
      level: "info",
      component: "devloop.pull-request-source",
      message: "Devloop PR state is readable again",
      ...(this.path ? { details: { path: this.path } } : {}),
    });
  }

  private writeLog(entry: PluginLogEntry): void {
    try {
      this.logger?.write(entry);
    } catch {
      // Diagnostics are best-effort and must not affect Forge fallback.
    }
  }
}

function errorKey(error: unknown): string {
  return error instanceof Error
    ? `${error.name}:${error.message}`
    : String(error);
}
