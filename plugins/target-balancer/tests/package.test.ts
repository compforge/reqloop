import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  BatonSessionResource,
  BatonSessionTargetBindingResource,
  BatonTargetResource,
  Hook,
  PluginContext,
  Resource,
  ResourceMergePatch,
} from "@compforge/baton-plugin";

import targetBalancer from "../src/index.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function activationHarness() {
  const root = mkdtempSync(join(tmpdir(), "target-balancer-"));
  roots.push(root);
  const namespace = "baton-system" as const;
  const metadata = (name: string) => ({
    name,
    namespace,
    uid: `uid-${name}`,
    generation: 1,
    resourceVersion: "1",
    creationTimestamp: "2026-08-28T00:00:00.000Z",
  });
  const targetRef = (name: string) => ({
    apiVersion: "baton.dev/v1alpha1" as const,
    kind: "Target" as const,
    namespace,
    name,
    uid: `uid-${name}`,
  });
  const sessionRef = (name: string) => ({
    apiVersion: "baton.dev/v1alpha1" as const,
    kind: "Session" as const,
    namespace,
    name,
    uid: `uid-${name}`,
  });
  const sessions: BatonSessionResource[] = ["current", "busy"].map((name) => ({
    apiVersion: "baton.dev/v1alpha1",
    kind: "Session",
    metadata: metadata(name),
    spec: {},
    status: { phase: "Active" },
  }));
  const targets: BatonTargetResource[] = ["codex", "codex2"].map((name) => ({
    apiVersion: "baton.dev/v1alpha1",
    kind: "Target",
    metadata: metadata(name),
    spec: { harness: "codex" },
    status: { phase: "Ready" },
  }));
  const bindings: BatonSessionTargetBindingResource[] = [
    {
      apiVersion: "baton.dev/v1alpha1",
      kind: "SessionTargetBinding",
      metadata: metadata("current"),
      spec: {
        sessionRef: sessionRef("current"),
        eligibleTargetRefs: targets.map((target) => targetRef(target.metadata.name)),
      },
      status: { observedGeneration: 1, phase: "Pending" },
    },
    {
      apiVersion: "baton.dev/v1alpha1",
      kind: "SessionTargetBinding",
      metadata: metadata("busy"),
      spec: {
        sessionRef: sessionRef("busy"),
        eligibleTargetRefs: targets.map((target) => targetRef(target.metadata.name)),
        targetRef: targetRef("codex"),
      },
      status: {
        observedGeneration: 1,
        effectiveTargetRef: targetRef("codex"),
        phase: "Bound",
      },
    },
  ];
  let hook: Hook<"view.input"> | undefined;
  const patches: ResourceMergePatch[] = [];
  const logs: unknown[] = [];

  const context = {
    instance: {
      pluginInstanceId: "target_balancer_default",
      batonSessionId: "current",
      pluginId: targetBalancer.pluginId,
      packageVersion: targetBalancer.version,
      enabled: true,
      config: { pools: { codex: ["codex", "codex2"] } },
      createdAt: "2026-08-28T00:00:00.000Z",
      updatedAt: "2026-08-28T00:00:00.000Z",
    },
    session: { batonSessionId: "current" },
    dataDirs: { global: root, project: root, session: root, instance: root },
    resources: {
      async list(type: { kind: string }) {
        if (type.kind === "Session") return sessions;
        if (type.kind === "Target") return targets;
        if (type.kind === "SessionTargetBinding") return bindings;
        return [];
      },
      async patch<TSpec, TStatus>(
        resource: Readonly<Resource<TSpec, TStatus>>,
        patch: ResourceMergePatch,
      ) {
        patches.push(patch);
        const selected = (patch.value.spec as { targetRef: ReturnType<typeof targetRef> })
          .targetRef;
        const index = bindings.findIndex((binding) =>
          binding.metadata.uid === resource.metadata.uid
        );
        const current = bindings[index]!;
        const updated: BatonSessionTargetBindingResource = {
          ...current,
          metadata: {
            ...current.metadata,
            generation: current.metadata.generation + 1,
            resourceVersion: String(Number(current.metadata.resourceVersion) + 1),
          },
          spec: { ...current.spec, targetRef: selected },
          status: {
            observedGeneration: current.metadata.generation + 1,
            effectiveTargetRef: selected,
            phase: "Bound",
          },
        };
        bindings[index] = updated;
        return updated as unknown as Readonly<Resource<TSpec, TStatus>>;
      },
    },
    hooks: {
      register(registered: Hook<"view.input">) {
        hook = registered;
      },
    },
    logger: {
      info(message: string, details: unknown) {
        logs.push({ message, details });
      },
      warn(message: string, details: unknown) {
        logs.push({ message, details });
      },
    },
  } as unknown as PluginContext;

  return {
    context,
    patches,
    logs,
    get hook() {
      if (!hook) throw new Error("view.input hook was not registered");
      return hook;
    },
  };
}

function prompt(targetId: string) {
  return {
    stage: "view.input" as const,
    subject: {
      inputId: "input-1",
      eventId: "event-1",
      seq: 1,
      input: { kind: "prompt" as const, text: "continue", harnessTargetId: targetId },
    },
    snapshot: {},
    verbs: {},
  } as Parameters<Hook<"view.input">["run"]>[0];
}

describe("Target Balancer PluginPackage", () => {
  test("keeps Package and Marketplace identities aligned", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../.baton-plugin/plugin.json", import.meta.url), "utf8"),
    ) as { pluginId: string; version: string; entry: string };
    const marketplace = JSON.parse(
      readFileSync(new URL("../../../.baton-plugin/marketplace.json", import.meta.url), "utf8"),
    ) as { plugins: Array<{ pluginId: string; source: string }> };
    const packageJson = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };

    expect(manifest.pluginId).toBe(targetBalancer.pluginId);
    expect(manifest.version).toBe(targetBalancer.version);
    expect(packageJson.version).toBe(targetBalancer.version);
    expect(manifest.entry).toBe("./src/index.ts");
    expect(marketplace.plugins).toContainEqual({
      pluginId: targetBalancer.pluginId,
      source: "./plugins/target-balancer",
    });
  });

  test("patches the first default prompt and keeps the resulting affinity", async () => {
    const harness = activationHarness();
    await targetBalancer.activate(harness.context);

    await harness.hook.run(prompt("codex"));
    expect(harness.patches).toHaveLength(1);
    expect(harness.patches[0]).toEqual({
      type: "merge",
      value: {
        spec: {
          targetRef: {
            apiVersion: "baton.dev/v1alpha1",
            kind: "Target",
            namespace: "baton-system",
            name: "codex2",
            uid: "uid-codex2",
          },
        },
      },
    });
    expect(harness.logs).toHaveLength(1);

    await harness.hook.run(prompt("codex"));
    expect(harness.patches).toHaveLength(1);
  });
});
