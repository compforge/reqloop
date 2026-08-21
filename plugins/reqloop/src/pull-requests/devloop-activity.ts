import {
  existsSync,
  readFileSync,
} from "node:fs";

import type { RepositoryIdentity } from "../repositories/protocol.ts";
import {
  discoverWorkspaceRepositories,
  type WorkspaceRepositoryCheckout,
} from "../workspaces/discovery.ts";
import { devloopStatePath } from "./devloop-state.ts";

const TOOL_CALL_SCHEMA = "devloop.tool-call/v1";
const TOOL_CALL_FILE = "tool-calls.jsonl";
const WINDOW_MS = 60 * 60 * 1_000;
const CHECKOUT_CACHE_MS = 30_000;
const ACTIVITY_CACHE_MS = 1_000;

const READ_TOOLS = new Set([
  "read",
  "grep",
  "glob",
  "ls",
  "find",
  "search",
  "view_image",
]);
const WRITE_TOOLS = new Set([
  "write",
  "edit",
  "multiedit",
  "notebookedit",
  "apply_patch",
]);

export interface ToolActivity {
  readonly started: number;
  readonly reads: number;
  readonly writes: number;
  readonly callsPerMinute: number;
  readonly trackPullRequests: boolean;
}

const NO_ACTIVITY: ToolActivity = Object.freeze({
  started: 0,
  reads: 0,
  writes: 0,
  callsPerMinute: 0,
  trackPullRequests: false,
});

/**
 * Reqloop's interpretation of devloop's raw one-hour timeline.
 *
 * Unknown and command-envelope tools remain neutral: devloop records facts,
 * while reqloop only treats explicit file mutation tools as write intent.
 */
export function interpretToolActivity(
  text: string,
  now = Date.now(),
): ToolActivity {
  let started = 0;
  let reads = 0;
  let writes = 0;
  const cutoff = now - WINDOW_MS;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const event = value as Record<string, unknown>;
    if (
      event.schema !== TOOL_CALL_SCHEMA ||
      event.kind !== "tool_call" ||
      event.phase !== "started" ||
      typeof event.ts !== "number" ||
      event.ts * 1_000 < cutoff ||
      typeof event.tool !== "string"
    ) {
      continue;
    }
    started += 1;
    const tool = event.tool.split(/[./:]/).at(-1)?.toLowerCase() ?? "";
    if (READ_TOOLS.has(tool)) reads += 1;
    if (WRITE_TOOLS.has(tool)) writes += 1;
  }
  return Object.freeze({
    started,
    reads,
    writes,
    callsPerMinute: started / 60,
    trackPullRequests: writes > reads,
  });
}

export class DevloopToolActivityPolicy {
  private checkoutCache?: {
    readonly expiresAt: number;
    readonly checkouts: readonly WorkspaceRepositoryCheckout[];
  };
  private readonly activityCache = new Map<string, {
    readonly expiresAt: number;
    readonly activity: ToolActivity;
  }>();

  constructor(
    private readonly root: string,
    private readonly now: () => number = Date.now,
  ) {}

  async forCheckout(path: string): Promise<ToolActivity> {
    const now = this.now();
    const cached = this.activityCache.get(path);
    if (cached && cached.expiresAt > now) return cached.activity;
    const statePath = await devloopStatePath(path, TOOL_CALL_FILE);
    let activity = NO_ACTIVITY;
    if (statePath && existsSync(statePath)) {
      try {
        activity = interpretToolActivity(readFileSync(statePath, "utf8"), now);
      } catch {
        activity = NO_ACTIVITY;
      }
    }
    this.activityCache.set(path, {
      expiresAt: now + ACTIVITY_CACHE_MS,
      activity,
    });
    return activity;
  }

  async shouldTrackCheckout(path: string): Promise<boolean> {
    return (await this.forCheckout(path)).trackPullRequests;
  }

  async shouldTrackIdentity(identity: RepositoryIdentity): Promise<boolean> {
    const checkout = (await this.checkouts()).find(({ identity: candidate }) =>
      candidate.forge === identity.forge &&
      candidate.path === identity.path
    );
    return checkout
      ? await this.shouldTrackCheckout(checkout.path)
      : false;
  }

  private async checkouts(): Promise<
    readonly WorkspaceRepositoryCheckout[]
  > {
    const now = this.now();
    if (this.checkoutCache && this.checkoutCache.expiresAt > now) {
      return this.checkoutCache.checkouts;
    }
    const checkouts = await discoverWorkspaceRepositories(this.root);
    this.checkoutCache = {
      expiresAt: now + CHECKOUT_CACHE_MS,
      checkouts,
    };
    return checkouts;
  }
}
