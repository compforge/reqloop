import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import type {
  PluginContext,
  ReconcileContext,
  Resource,
} from "@compforge/baton-plugin";

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
      controllers: {
        register(controller: {
          resourceType: { kind: string };
          present?: typeof present;
        }) {
          if (controller.resourceType.kind === "CounterState") {
            present = controller.present;
          }
        },
      },
      logger: { info() {} },
    } as unknown as PluginContext);

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

  test("derives an idempotent count from the current turn snapshot", async () => {
    type Counter = Resource<
      { enabled: boolean },
      {
        totalTurns?: number;
        lastTurnId?: string;
        lastUserText?: string;
        observedGeneration?: number;
      }
    >;
    let counter: Readonly<Counter> | undefined;
    let reconcileTurn:
      | ((context: ReconcileContext, turn: Resource) => Promise<void>)
      | undefined;
    let patches = 0;
    const context = {
      resources: {
        async list() {
          return counter ? [counter] : [];
        },
        async create(type: { apiVersion: string; kind: string }) {
          counter = {
            ...type,
            metadata: {
              name: "main",
              namespace: "v1",
              uid: "uid-main",
              generation: 1,
              resourceVersion: "1",
              creationTimestamp: "2026-08-28T00:00:00.000Z",
            },
            spec: { enabled: true },
            status: {},
          };
          return counter;
        },
        async patchStatus(current: Counter, patch: Counter["status"]) {
          patches += 1;
          counter = {
            ...current,
            metadata: {
              ...current.metadata,
              resourceVersion: String(Number(current.metadata.resourceVersion) + 1),
            },
            status: { ...current.status, ...patch },
          };
          return counter;
        },
      },
      controllers: {
        register(controller: {
          resourceType: { kind: string };
          reconcile: typeof reconcileTurn;
        }) {
          if (controller.resourceType.kind === "Turn") {
            reconcileTurn = controller.reconcile;
          }
        },
      },
      logger: { info() {} },
    } as unknown as PluginContext;
    await helloCounter.activate(context);
    if (!reconcileTurn) throw new Error("Turn controller was not registered");
    const reconcile = {
      snapshot: {
        turns: [{ turnId: "t1", toolCalls: [] }, { turnId: "t2", toolCalls: [] }],
      },
    } as unknown as ReconcileContext;
    const turn = {
      apiVersion: "baton.dev/v1alpha1",
      kind: "Turn",
      metadata: {
        name: "t2",
        namespace: "baton-system",
        uid: "uid-t2",
        generation: 1,
        resourceVersion: "2",
        creationTimestamp: "2026-08-28T00:00:00.000Z",
      },
      spec: {},
      status: { turnId: "t2", userText: "latest question", toolCalls: [] },
    } as Resource;

    await reconcileTurn(reconcile, turn);
    await reconcileTurn(reconcile, turn);

    expect(counter?.status).toMatchObject({
      totalTurns: 2,
      lastTurnId: "t2",
      lastUserText: "latest question",
    });
    expect(patches).toBe(2);
  });
});
