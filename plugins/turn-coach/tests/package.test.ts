import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import turnCoach from "../src/index.ts";

interface StateResource {
  apiVersion: "turn-coach.baton.dev/v1alpha1";
  kind: "TurnCoachState";
  metadata: {
    name: "main";
    namespace: string;
    uid: string;
    generation: number;
    resourceVersion: string;
    creationTimestamp: string;
  };
  spec: {
    enabled: boolean;
  };
  status: {
    activatedAt?: string;
    coachedTurns?: number;
    lastCoachedAt?: string;
    lastCoachedResourceVersion?: string;
    lastTurnId?: string;
    observedGeneration?: number;
  };
}

interface ReconcileResult {
  output?: {
    kind: "proposed-input";
    text: string;
  };
}

type TestReconciler = (
  baton: {
    turns: Array<{ turnId: string }>;
  },
  resource: StateResource | ReturnType<typeof turnResource>,
) => Promise<ReconcileResult | void>;

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
      namespace: "baton-system",
      uid: `uid-${turnId}`,
      generation: 1,
      resourceVersion: String(revision),
      creationTimestamp: observedAt,
    },
    spec: {},
    status: {
      turnId,
      userText,
      toolCalls: [],
    },
  };
}

function activationHarness() {
  let state: StateResource | undefined;
  let stateReconciler: TestReconciler | undefined;
  let turnReconciler: TestReconciler | undefined;
  let statusPatches = 0;

  const resources = {
    get() {
      if (!state) throw new Error("resource not found");
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
          namespace: "turn_coach_default",
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
    delete() {
      state = undefined;
    },
    patchStatus(resource: StateResource, patch: Partial<StateResource["status"]>) {
      if (resource.metadata.resourceVersion !== state?.metadata.resourceVersion) {
        throw new Error("resource version conflict");
      }
      statusPatches += 1;
      state = {
        ...resource,
        metadata: {
          ...resource.metadata,
          resourceVersion: String(
            Number(resource.metadata.resourceVersion) + 1,
          ),
        },
        status: {
          ...resource.status,
          ...patch,
        },
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
    registerController(controller: {
      resourceType: { kind: string };
      reconcile: TestReconciler;
    }) {
      if (controller.resourceType.kind === "TurnCoachState") {
        stateReconciler = controller.reconcile;
      } else if (controller.resourceType.kind === "Turn") {
        turnReconciler = controller.reconcile;
      } else {
        throw new Error(
          `unexpected Resource kind: ${controller.resourceType.kind}`,
        );
      }
    },
    onClose() {},
  } as unknown as Parameters<typeof turnCoach.activate>[0];

  turnCoach.activate(context);

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
  };
}

describe("Turn Coach PluginPackage", () => {
  test("keeps runtime, Package, and Marketplace identities aligned", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../.baton-plugin/plugin.json", import.meta.url), "utf8"),
    ) as {
      pluginId: string;
      version: string;
      entry: string;
    };
    const packageJson = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    const marketplace = JSON.parse(
      readFileSync(new URL("../../../.baton-plugin/marketplace.json", import.meta.url), "utf8"),
    ) as {
      plugins: Array<{ pluginId: string; source: string }>;
    };

    expect(turnCoach.pluginId).toBe(manifest.pluginId);
    expect(turnCoach.version).toBe(manifest.version);
    expect(packageJson.version).toBe(manifest.version);
    expect(manifest.entry).toBe("./src/index.ts");
    expect(marketplace.plugins).toContainEqual({
      pluginId: turnCoach.pluginId,
      source: "./plugins/turn-coach",
    });
  });

  test("persists a monotonic turn watermark and returns a replay-safe proposal", async () => {
    const harness = activationHarness();
    const baton = {
      turns: [{ turnId: "t_1" }, { turnId: "t_2" }],
    };
    const turn = turnResource(
      12,
      "t_2",
      "  Check the implementation\nand tell me what should happen next.  ",
    );

    const first = await harness.turnReconciler(baton, turn);

    expect(first?.output).toEqual({
      kind: "proposed-input",
      text: [
        "Review the previous turn against the original request below.",
        "Identify missing work or material risks, then recommend the single best next step.",
        "",
        "Original request: Check the implementation and tell me what should happen next.",
      ].join("\n"),
    });
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

    const replayed = await harness.turnReconciler(baton, turn);

    expect(replayed).toEqual(first);
    expect(harness.statusPatches).toBe(2);
    expect(harness.state?.status.lastCoachedResourceVersion).toBe("12");
  });

  test("does not regress state when older ledger turns are replayed", async () => {
    const harness = activationHarness();
    await harness.turnReconciler(
      { turns: [{ turnId: "t_new" }] },
      turnResource(
        20,
        "t_new",
        "new request",
        "2026-07-27T10:00:00.000Z",
      ),
    );

    const older = await harness.turnReconciler(
      { turns: [{ turnId: "t_old" }, { turnId: "t_new" }] },
      turnResource(
        10,
        "t_old",
        "old request",
        "2026-07-27T09:00:00.000Z",
      ),
    );

    expect(older?.output?.text).toContain("Original request: old request");
    expect(harness.statusPatches).toBe(2);
    expect(harness.state?.status).toMatchObject({
      lastCoachedResourceVersion: "20",
      lastTurnId: "t_new",
    });
  });

  test("does not propose turns that predate the first activation", async () => {
    const harness = activationHarness();
    const activatedAt = harness.state?.status.activatedAt;
    if (!activatedAt) throw new Error("activation boundary was not persisted");
    const historicalTime = new Date(Date.parse(activatedAt) - 1).toISOString();

    const historical = await harness.turnReconciler(
      { turns: [{ turnId: "t_historical" }] },
      turnResource(3, "t_historical", "old request", historicalTime),
    );

    expect(historical).toBeUndefined();
    expect(harness.state?.status).toMatchObject({
      coachedTurns: 0,
    });
    expect(
      harness.state?.status.lastCoachedResourceVersion,
    ).toBeUndefined();
    expect(harness.statusPatches).toBe(1);
  });

  test("brings Resource status to its current spec generation", async () => {
    const harness = activationHarness();
    const state = harness.state;
    if (!state) throw new Error("TurnCoachState was not created");
    state.status.observedGeneration = 0;

    await harness.stateReconciler({ turns: [] }, state);

    expect(harness.state?.status.observedGeneration).toBe(1);
    expect(harness.statusPatches).toBe(2);
  });
});
