import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import type {
  DraftInput,
  PluginContext,
  ReconcileContext,
} from "@compforge/baton-plugin";

import turnCoach from "../src/index.ts";

interface StateResource {
  apiVersion: "turn-coach.baton.dev/v1alpha1";
  kind: "TurnCoachState";
  metadata: {
    name: "main";
    namespace: "v1";
    uid: string;
    generation: number;
    resourceVersion: string;
    creationTimestamp: string;
  };
  spec: { enabled: boolean };
  status: {
    activatedAt?: string;
    coachedTurns?: number;
    lastCoachedAt?: string;
    lastCoachedResourceVersion?: string;
    lastTurnId?: string;
    observedGeneration?: number;
  };
}

function turnResource(
  revision: number,
  turnId: string,
  userText: string,
  observedAt = "9999-01-01T00:00:00.000Z",
) {
  return {
    apiVersion: "baton.dev/v1alpha1" as const,
    kind: "Turn" as const,
    metadata: {
      name: turnId,
      namespace: "baton-system" as const,
      uid: `uid-${turnId}`,
      generation: 1,
      resourceVersion: String(revision),
      creationTimestamp: observedAt,
    },
    spec: {},
    status: { turnId, userText, toolCalls: [] },
  };
}

type TestResource = StateResource | ReturnType<typeof turnResource>;
type TestReconciler = (
  context: ReconcileContext,
  resource: TestResource,
) => Promise<void | { readonly requeueAfterMs?: number }>;

function reconcileContext(turnCount: number, drafts: DraftInput[]): ReconcileContext {
  const turns = Array.from({ length: turnCount }, (_, index) => ({
    turnId: `t_${index + 1}`,
    toolCalls: [],
  }));
  return {
    snapshot: {
      session: {
        batonSessionId: "session-1",
        runState: "idle",
        revision: turnCount,
      },
      activeTurns: [],
      harnessInputs: [],
      harnessTargets: [],
      pendingInteractions: [],
      turns,
      latestTurn: turns.at(-1),
    },
    verbs: {
      async draft(input) {
        drafts.push(input);
        return { state: "dismissed" };
      },
    } as ReconcileContext["verbs"],
  };
}

async function activationHarness() {
  let state: StateResource | undefined;
  let stateReconciler: TestReconciler | undefined;
  let turnReconciler: TestReconciler | undefined;
  let statusPatches = 0;
  const drafts: DraftInput[] = [];

  const resources = {
    get() {
      return state;
    },
    list() {
      return state ? [state] : [];
    },
    create() {
      if (state) throw new Error("resource already exists");
      state = {
        apiVersion: "turn-coach.baton.dev/v1alpha1",
        kind: "TurnCoachState",
        metadata: {
          name: "main",
          namespace: "v1",
          uid: "uid-main",
          generation: 1,
          resourceVersion: "1",
          creationTimestamp: new Date().toISOString(),
        },
        spec: { enabled: true },
        status: {},
      };
      return state;
    },
    patchStatus(
      resource: StateResource,
      patch: Partial<StateResource["status"]>,
    ) {
      if (resource.metadata.resourceVersion !== state?.metadata.resourceVersion) {
        throw new Error("resource version conflict");
      }
      statusPatches += 1;
      state = {
        ...resource,
        metadata: {
          ...resource.metadata,
          resourceVersion: String(Number(resource.metadata.resourceVersion) + 1),
        },
        status: { ...resource.status, ...patch },
      };
      return state;
    },
  };
  const context = {
    instance: {
      pluginInstanceId: "turn_coach_default",
      pluginId: turnCoach.pluginId,
      packageVersion: turnCoach.version,
      enabled: true,
      config: {},
    },
    resources,
    controllers: {
      register(controller: {
        resourceType: { kind: string };
        reconcile: TestReconciler;
      }) {
        if (controller.resourceType.kind === "TurnCoachState") {
          stateReconciler = controller.reconcile;
        } else if (controller.resourceType.kind === "Turn") {
          turnReconciler = controller.reconcile;
        } else {
          throw new Error(`unexpected Resource kind: ${controller.resourceType.kind}`);
        }
      },
    },
  } as unknown as PluginContext;

  await turnCoach.activate(context);

  return {
    get state() {
      return state;
    },
    get stateReconciler() {
      if (!stateReconciler) throw new Error("state reconciler was not registered");
      return stateReconciler;
    },
    get turnReconciler() {
      if (!turnReconciler) throw new Error("turn reconciler was not registered");
      return turnReconciler;
    },
    get statusPatches() {
      return statusPatches;
    },
    drafts,
  };
}

describe("Turn Coach PluginPackage", () => {
  test("keeps Package and Marketplace identities aligned", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../.baton-plugin/plugin.json", import.meta.url), "utf8"),
    ) as { pluginId: string; version: string; entry: string };
    const packageJson = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    const marketplace = JSON.parse(
      readFileSync(new URL("../../../.baton-plugin/marketplace.json", import.meta.url), "utf8"),
    ) as { plugins: Array<{ pluginId: string; source: string }> };

    expect(turnCoach.pluginId).toBe(manifest.pluginId);
    expect(turnCoach.version).toBe(manifest.version);
    expect(packageJson.version).toBe(manifest.version);
    expect(manifest.entry).toBe("./src/index.ts");
    expect(marketplace.plugins).toContainEqual({
      pluginId: turnCoach.pluginId,
      source: "./plugins/turn-coach",
    });
  });

  test("persists a monotonic watermark and requests one editable draft", async () => {
    const harness = await activationHarness();
    const turn = turnResource(
      12,
      "t_2",
      "  Check the implementation\nand tell me what should happen next.  ",
    );

    await harness.turnReconciler(reconcileContext(2, harness.drafts), turn);

    expect(harness.drafts).toEqual([{
      title: "Review the previous turn",
      prompt: [
        "Review the previous turn against the original request below.",
        "Identify missing work or material risks, then recommend the single best next step.",
        "",
        "Original request: Check the implementation and tell me what should happen next.",
      ].join("\n"),
      timeoutMs: 604_800_000,
    }]);
    const state = harness.state;
    if (!state) throw new Error("TurnCoachState was not created");
    expect(state.status).toEqual({
      activatedAt: state.status.activatedAt,
      coachedTurns: 2,
      lastCoachedAt: "9999-01-01T00:00:00.000Z",
      lastCoachedResourceVersion: "12",
      lastTurnId: "t_2",
      observedGeneration: 1,
    });
    expect(harness.statusPatches).toBe(2);

    await harness.turnReconciler(reconcileContext(2, harness.drafts), turn);
    expect(harness.drafts).toHaveLength(1);
    expect(harness.statusPatches).toBe(2);
  });

  test("does not regress state or draft when older turns replay", async () => {
    const harness = await activationHarness();
    await harness.turnReconciler(
      reconcileContext(1, harness.drafts),
      turnResource(20, "t_new", "new request", "9999-07-27T10:00:00.000Z"),
    );
    await harness.turnReconciler(
      reconcileContext(2, harness.drafts),
      turnResource(10, "t_old", "old request", "9999-07-27T09:00:00.000Z"),
    );

    expect(harness.drafts).toHaveLength(1);
    expect(harness.statusPatches).toBe(2);
    expect(harness.state?.status).toMatchObject({
      lastCoachedResourceVersion: "20",
      lastTurnId: "t_new",
    });
  });

  test("ignores turns that predate the first activation", async () => {
    const harness = await activationHarness();
    const activatedAt = harness.state?.status.activatedAt;
    if (!activatedAt) throw new Error("activation boundary was not persisted");

    await harness.turnReconciler(
      reconcileContext(1, harness.drafts),
      turnResource(
        3,
        "t_historical",
        "old request",
        new Date(Date.parse(activatedAt) - 1).toISOString(),
      ),
    );

    expect(harness.drafts).toEqual([]);
    expect(harness.state?.status.coachedTurns).toBe(0);
    expect(harness.statusPatches).toBe(1);
  });

  test("brings Resource status to its current spec generation", async () => {
    const harness = await activationHarness();
    const state = harness.state;
    if (!state) throw new Error("TurnCoachState was not created");
    state.status.observedGeneration = 0;

    await harness.stateReconciler(reconcileContext(0, harness.drafts), state);

    expect(harness.state?.status.observedGeneration).toBe(1);
    expect(harness.statusPatches).toBe(2);
  });
});
