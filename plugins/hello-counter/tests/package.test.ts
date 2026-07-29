import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import type { PluginActivationContext } from "@compforge/baton-plugin";

import helloCounter from "../src/index.ts";

interface PluginManifest {
  pluginId: string;
  version: string;
  entry: string;
}

describe("Hello Counter PluginPackage", () => {
  test("keeps its Package identity aligned with manifest metadata", () => {
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

  test("presents initialized counter state on the Board and omits empty status", async () => {
    let present:
      | ((resource: unknown) => Promise<{
          title: string;
          status?: string;
          detail?: string;
          tone?: string;
        } | undefined>)
      | undefined;
    await helloCounter.activate({
      registerController(controller: {
        resourceType: { kind: string };
        present?: typeof present;
      }) {
        if (controller.resourceType.kind === "CounterState") {
          present = controller.present;
        }
      },
    } as unknown as PluginActivationContext);

    const resource = {
      apiVersion: "hello-counter.baton.dev/v1alpha1",
      kind: "CounterState",
      metadata: {
        name: "main",
        namespace: "hello_counter",
        uid: "uid-main",
        generation: 1,
        resourceVersion: "2",
        creationTimestamp: "2026-07-25T00:00:00.000Z",
      },
      spec: { enabled: true },
      status: {},
    };
    expect(await present?.(resource)).toBeUndefined();
    expect(
      await present?.({
        ...resource,
        status: {
          totalTurns: 2,
          lastUserText: "Add the Board",
          observedGeneration: 1,
        },
      }),
    ).toEqual({
      title: "Hello Counter",
      status: "2 turns",
      detail: "Latest: Add the Board",
      tone: "success",
    });
  });
});
