import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import type { PluginActivationContext } from "@baton/plugin";

import helloCounter from "../src/index.ts";

interface PluginManifest {
  pluginId: string;
  version: string;
  entry: string;
}

describe("Hello Counter PluginPackage", () => {
  test("keeps its runtime identity aligned with the Package metadata", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../.baton-plugin/plugin.json", import.meta.url), "utf8"),
    ) as PluginManifest;
    const packageJson = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };

    expect(helloCounter.pluginId).toBe(manifest.pluginId);
    expect(helloCounter.version).toBe(manifest.version);
    expect(packageJson.version).toBe(manifest.version);
    expect(manifest.entry).toBe("./src/index.ts");
    expect(typeof helloCounter.activate).toBe("function");
  });

  test("projects initialized counter state into the Board and omits empty status", async () => {
    let board:
      | {
          project(resource: unknown): readonly {
            key: string;
            title: string;
            status?: string;
            detail?: string;
            tone?: string;
          }[];
        }
      | undefined;
    await helloCounter.activate({
      registerResource(contribution: { board?: typeof board }) {
        board = contribution.board;
      },
      watchBuiltinResource() {},
    } as unknown as PluginActivationContext);

    const resource = {
      kind: "CounterState",
      metadata: {
        resourceId: "main",
        batonSessionId: "bs_test",
        pluginInstanceId: "hello_counter",
        generation: 1,
        resourceVersion: 2,
        createdAt: "2026-07-25T00:00:00.000Z",
        updatedAt: "2026-07-25T00:00:00.000Z",
      },
      spec: { enabled: true },
      status: {},
    };
    expect(board?.project(resource)).toEqual([]);
    expect(
      board?.project({
        ...resource,
        status: {
          totalTurns: 2,
          lastUserText: "Add the Board",
          observedGeneration: 1,
        },
      }),
    ).toEqual([
      {
        key: "summary",
        title: "Hello Counter",
        status: "2 turns",
        detail: "Latest: Add the Board",
        tone: "success",
      },
    ]);
  });
});
