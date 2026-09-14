import type { BatonTargetResource, PluginContext } from "@compforge/baton-plugin";

interface Preset {
  readonly model: string;
  readonly effort: string;
}

type Presets = Readonly<Record<string, Readonly<Record<string, Preset>>>>;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parsePresets(config: Readonly<Record<string, unknown>>): Presets {
  if (config.presets === undefined) return {};
  if (!record(config.presets)) throw new Error("boost config.presets must be an object");
  const presets: Record<string, Record<string, Preset>> = {};
  for (const [name, families] of Object.entries(config.presets)) {
    if (name !== "easy" && name !== "hard") throw new Error(`Unknown boost preset: ${name}`);
    if (!record(families)) throw new Error(`boost config.presets.${name} must be an object`);
    const parsed: Record<string, Preset> = {};
    for (const [harness, selection] of Object.entries(families)) {
      if (!harness.trim() || !record(selection) ||
        typeof selection.model !== "string" || !selection.model.trim() ||
        typeof selection.effort !== "string" || !selection.effort.trim()) {
        throw new Error(`boost config.presets.${name}.${harness} requires non-empty model and effort`);
      }
      parsed[harness] = { model: selection.model, effort: selection.effort };
    }
    presets[name] = parsed;
  }
  return presets;
}

/** Presets are shortcuts for Baton's persistent model + effort configuration. */
export function registerPresets(context: PluginContext): void {
  const presets = parsePresets(context.instance.config);
  for (const name of ["easy", "hard"] as const) {
    context.commands.register({
      name,
      description: name === "easy" ? "Use a fast model for simple tasks" : "Use a capable model for complex tasks",
      async execute(input, command) {
        const prompt = input.argument.trim();
        if (!command.target) throw new Error(`/${name} requires a Baton Session target`);
        const selection = presets[name]?.[command.target.harness];
        if (!selection) {
          throw new Error(`Configure boost presets.${name}.${command.target.harness} with model and effort first`);
        }
        const targets = await context.resources.list<BatonTargetResource["spec"], BatonTargetResource["status"]>({ apiVersion: "baton.dev/v1alpha1", kind: "Target" });
        const listed = targets.find((target) => target.metadata.name === command.target!.id);
        if (!listed) throw new Error(`Target is unavailable: ${command.target.id}`);
        const target = await context.resources.get<BatonTargetResource["spec"], BatonTargetResource["status"]>({
          apiVersion: listed.apiVersion, kind: listed.kind, namespace: listed.metadata.namespace,
          name: listed.metadata.name, uid: listed.metadata.uid,
        });
        const catalog = target?.status.modelCatalog;
        if (catalog?.phase !== "Ready") {
          throw new Error(`Model catalog for ${command.target.id}: ${catalog?.phase ?? "Unavailable"}`);
        }
        const model = catalog.models.find((candidate) => candidate.id === selection.model);
        if (!model) {
          throw new Error(`Unknown model ${selection.model} for ${command.target.id}; available: ${catalog.models.map((candidate) => candidate.id).join(", ")}`);
        }
        if (!model.efforts.some((candidate) => candidate.id === selection.effort)) {
          throw new Error(`Model ${model.id} does not support effort ${selection.effort}; available: ${model.efforts.map((candidate) => candidate.id).join(", ")}`);
        }
        await command.verbs.configureModel(selection);
        if (prompt) await command.verbs.submit({ prompt });
        return { kind: "message", text: `${command.target.id}: ${selection.model} / ${selection.effort}` };
      },
    });
  }
}
