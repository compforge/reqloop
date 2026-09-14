import { describe, expect, test } from "bun:test";
import type { BatonTargetModelCatalog, Command, PluginContext } from "@compforge/baton-plugin";
import boost from "../src/index.ts";
import { parsePresets } from "../src/presets.ts";

function fixture(config: Record<string, unknown>) {
  const commands = new Map<string, Command>();
  let hooks = 0;
  let catalog: BatonTargetModelCatalog = { phase: "Ready", observedAt: "2026-09-14T00:00:00Z", models: modelCatalog };
  const target = () => ({
    apiVersion: "baton.dev/v1alpha1", kind: "Target",
    metadata: { name: "codex2", namespace: "baton-system", uid: "target-2" },
    spec: { harness: "codex" }, status: { phase: "Ready", modelCatalog: catalog },
  });
  const context = {
    instance: { config },
    commands: { register(command: Command) { commands.set(command.name, command); } },
    hooks: { register() { hooks++; } },
    resources: {
      async list() { return [target()]; },
      async get(ref: { name: string; uid?: string }) {
        expect(ref).toMatchObject({ name: "codex2", uid: "target-2" });
        return target();
      },
    },
  } as unknown as PluginContext;
  return { context, commands, setCatalog(value: BatonTargetModelCatalog) { catalog = value; }, get hooks() { return hooks; } };
}

const presets = {
  easy: { codex: { model: "fast-model", effort: "medium" } },
  hard: { codex: { model: "capable-model", effort: "high" } },
};
const modelCatalog = [
  { id: "fast-model", label: "Fast", efforts: [{ id: "medium", label: "Medium" }] },
  { id: "capable-model", label: "Capable", efforts: [{ id: "high", label: "High" }] },
];

describe("Boost presets", () => {
  for (const pools of [undefined, {}, { codex: [] }]) {
    test(`presets work without balancing: ${JSON.stringify(pools)}`, async () => {
      const harness = fixture({ presets, ...(pools === undefined ? {} : { pools }) });
      await boost.activate(harness.context);
      expect(harness.hooks).toBe(0);
      const target = { id: "codex2", harness: "codex" };
      expect(await harness.commands.get("easy")!.execute({ argument: "", target })).toEqual({
        kind: "model_configuration", model: "fast-model", effort: "medium",
      });
      expect(await harness.commands.get("hard")!.execute({ argument: "  solve this  ", target })).toEqual({
        kind: "model_configuration", model: "capable-model", effort: "high", prompt: "solve this",
      });
    });
  }

  test("unconfigured family and missing target fail explicitly", async () => {
    const harness = fixture({ presets });
    await boost.activate(harness.context);
    const easy = harness.commands.get("easy")!;
    expect(easy.execute({ argument: "" })).rejects.toThrow("requires a Baton Session target");
    expect(easy.execute({ argument: "", target: { id: "other", harness: "claude" } })).rejects.toThrow("presets.easy.claude");
  });

  test("rejects malformed presets without installing partial commands", () => {
    for (const value of [null, [], { easy: null }, { easy: { codex: { model: "x" } } }, { auto: {} }]) {
      expect(() => parsePresets({ presets: value })).toThrow();
    }
  });

  test("uses the discovered model-specific effort list and reports available choices", async () => {
    const harness = fixture({ presets });
    await boost.activate(harness.context);
    const easy = harness.commands.get("easy")!;
    const target = { id: "codex2", harness: "codex" };
    for (const phase of ["Pending", "Failed", "Unavailable"] as const) {
      harness.setCatalog({ phase, observedAt: "now", message: "failed" });
      await expect(easy.execute({ argument: "task", target })).rejects.toThrow(phase);
    }
    harness.setCatalog({ phase: "Ready", observedAt: "now", models: [modelCatalog[1]!] });
    await expect(easy.execute({ argument: "task", target })).rejects.toThrow("available: capable-model");
    harness.setCatalog({ phase: "Ready", observedAt: "now", models: [{ ...modelCatalog[0]!, efforts: [] }] });
    await expect(easy.execute({ argument: "task", target })).rejects.toThrow("does not support effort medium");
  });
});
