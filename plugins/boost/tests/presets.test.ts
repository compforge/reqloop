import { describe, expect, test } from "bun:test";
import type { BatonTargetModelCatalog, CommandDefinition, CommandContext, CommandSubmitInput, PluginContext } from "@compforge/baton-plugin";
import boost from "../src/index.ts";
import { parsePresets } from "../src/presets.ts";

function fixture(config: Record<string, unknown>) {
  const commands = new Map<string, CommandDefinition>();
  let hooks = 0;
  const submissions: CommandSubmitInput[] = [];
  const configurations: { model?: string; effort?: string }[] = [];
  const actions: string[] = [];
  function invocation(name: string, target: CommandContext["target"] = { id: "codex2", harness: "codex" }): CommandContext {
    return {
      executionId: "test-command", command: { namespace: "compforge/boost", name }, target,
      verbs: {
        async submit(input) { actions.push("submit"); submissions.push(input); return { messageId: "m", turnId: "t", queued: false }; },
        async configureModel(input) { actions.push("configureModel"); configurations.push(input); },
      },
    };
  }
  let catalog: BatonTargetModelCatalog = { phase: "Ready", observedAt: "2026-09-14T00:00:00Z", models: modelCatalog };
  const target = () => ({
    apiVersion: "baton.dev/v1alpha1", kind: "Target",
    metadata: { name: "codex2", namespace: "baton-system", uid: "target-2" },
    spec: { harness: "codex" }, status: { phase: "Ready", modelCatalog: catalog },
  });
  const context = {
    instance: { config },
    commands: { register(command: CommandDefinition) { commands.set(command.name, command); } },
    hooks: { register() { hooks++; } },
    resources: {
      async list() { return [target()]; },
      async get(ref: { name: string; uid?: string }) {
        expect(ref).toMatchObject({ name: "codex2", uid: "target-2" });
        return target();
      },
    },
  } as unknown as PluginContext;
  return { context, commands, invocation, submissions, configurations, actions, setCatalog(value: BatonTargetModelCatalog) { catalog = value; }, get hooks() { return hooks; } };
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
      await harness.commands.get("easy")!.execute({ argument: "explain this" }, harness.invocation("easy"));
      await harness.commands.get("hard")!.execute({ argument: "  solve this  " }, harness.invocation("hard"));
      expect(harness.submissions).toEqual([
        { prompt: "explain this" },
        { prompt: "solve this" },
      ]);
      expect(await harness.commands.get("easy")!.execute({ argument: "" }, harness.invocation("easy"))).toEqual({
        kind: "message", text: "codex2: fast-model / medium",
      });
      expect(harness.submissions).toHaveLength(2);
      expect(harness.configurations).toEqual([presets.easy.codex, presets.hard.codex, presets.easy.codex]);
      expect(harness.actions).toEqual(["configureModel", "submit", "configureModel", "submit", "configureModel"]);
    });
  }

  test("a failed configuration never submits the trailing task", async () => {
    const harness = fixture({ presets });
    await boost.activate(harness.context);
    const invocation = harness.invocation("easy");
    await expect(harness.commands.get("easy")!.execute({ argument: "task" }, {
      ...invocation, verbs: { ...invocation.verbs, async configureModel() { throw new Error("not available"); } },
    })).rejects.toThrow("not available");
    expect(harness.submissions).toEqual([]);
  });

  test("unconfigured family and missing target fail explicitly", async () => {
    const harness = fixture({ presets });
    await boost.activate(harness.context);
    const easy = harness.commands.get("easy")!;
    expect(easy.execute({ argument: "task" }, { ...harness.invocation("easy"), target: undefined })).rejects.toThrow("requires a Baton Session target");
    expect(easy.execute({ argument: "task" }, harness.invocation("easy", { id: "other", harness: "claude" }))).rejects.toThrow("presets.easy.claude");
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
      await expect(easy.execute({ argument: "task" }, harness.invocation("easy", target))).rejects.toThrow(phase);
    }
    harness.setCatalog({ phase: "Ready", observedAt: "now", models: [modelCatalog[1]!] });
    await expect(easy.execute({ argument: "task" }, harness.invocation("easy", target))).rejects.toThrow("available: capable-model");
    harness.setCatalog({ phase: "Ready", observedAt: "now", models: [{ ...modelCatalog[0]!, efforts: [] }] });
    await expect(easy.execute({ argument: "task" }, harness.invocation("easy", target))).rejects.toThrow("does not support effort medium");
  });
});
