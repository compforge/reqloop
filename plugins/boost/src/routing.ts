import type {
  BatonSessionResource,
  BatonSessionTargetBindingResource,
  BatonTargetResource,
  ResourceRef,
} from "@compforge/baton-plugin";

export interface TargetBalancerConfig {
  readonly pools: Readonly<Record<string, readonly string[]>>;
}

export interface TargetAssignment {
  readonly target: BatonTargetResource;
  readonly loads: Readonly<Record<string, number>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseTargetBalancerConfig(
  config: Readonly<Record<string, unknown>>,
): TargetBalancerConfig {
  if (config.pools === undefined) return { pools: Object.freeze({}) };
  if (!isRecord(config.pools)) {
    throw new Error("boost config.pools must be an object");
  }

  const pools: Record<string, readonly string[]> = {};
  for (const [harness, value] of Object.entries(config.pools)) {
    if (!harness.trim()) {
      throw new Error("boost pool names must not be empty");
    }
    if (
      !Array.isArray(value) ||
      value.some((targetId) =>
        typeof targetId !== "string" || !targetId.trim()
      )
    ) {
      throw new Error(
        `boost config.pools.${harness} must be a string array`,
      );
    }
    pools[harness] = Object.freeze([...new Set(value)]);
  }

  return { pools: Object.freeze(pools) };
}

function matchesRef(target: BatonTargetResource, ref: ResourceRef): boolean {
  return target.apiVersion === ref.apiVersion &&
    target.kind === ref.kind &&
    target.metadata.namespace === ref.namespace &&
    target.metadata.name === ref.name &&
    (ref.uid === undefined || target.metadata.uid === ref.uid);
}

export function isDefaultTarget(target: BatonTargetResource): boolean {
  return target.metadata.name === target.spec.harness;
}

export function chooseTarget(input: {
  readonly requestedTarget: BatonTargetResource;
  readonly currentBinding: BatonSessionTargetBindingResource;
  readonly sessions: readonly BatonSessionResource[];
  readonly targets: readonly BatonTargetResource[];
  readonly bindings: readonly BatonSessionTargetBindingResource[];
  readonly config: TargetBalancerConfig;
}): TargetAssignment | undefined {
  if (!isDefaultTarget(input.requestedTarget)) return undefined;
  if (
    input.currentBinding.spec.targetRef ||
    input.currentBinding.status.effectiveTargetRef
  ) {
    return undefined;
  }

  const harness = input.requestedTarget.spec.harness;
  const configuredPool = input.config.pools[harness];
  if (!configuredPool) return undefined;
  const configuredTargetIds = new Set(configuredPool);

  const candidates = input.targets.filter((target) =>
    target.spec.harness === harness &&
    target.status.phase === "Ready" &&
    input.currentBinding.spec.eligibleTargetRefs.some((ref) =>
      matchesRef(target, ref)
    ) &&
    configuredTargetIds.has(target.metadata.name)
  );
  if (candidates.length < 2) return undefined;

  const loads = Object.fromEntries(
    candidates.map((candidate) => [candidate.metadata.name, 0]),
  ) as Record<string, number>;
  const activeSessionIds = new Set(
    input.sessions
      .filter((session) => session.status.phase === "Active")
      .map((session) => session.metadata.name),
  );

  for (const binding of input.bindings) {
    if (!activeSessionIds.has(binding.spec.sessionRef.name)) continue;
    const selected = binding.status.effectiveTargetRef ?? binding.spec.targetRef;
    if (selected && loads[selected.name] !== undefined) {
      loads[selected.name] += 1;
    }
  }

  candidates.sort((left, right) =>
    loads[left.metadata.name]! - loads[right.metadata.name]! ||
    left.metadata.name.localeCompare(right.metadata.name)
  );
  return {
    target: candidates[0]!,
    loads: Object.freeze({ ...loads }),
  };
}
