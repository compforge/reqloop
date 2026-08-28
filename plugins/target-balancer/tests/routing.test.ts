import { describe, expect, test } from "bun:test";

import type {
  BatonSessionResource,
  BatonSessionTargetBindingResource,
  BatonTargetResource,
  ResourceRef,
} from "@compforge/baton-plugin";

import {
  chooseTarget,
  parseTargetBalancerConfig,
} from "../src/routing.ts";

const API_VERSION = "baton.dev/v1alpha1" as const;
const NAMESPACE = "baton-system" as const;

function metadata(name: string, revision = 1) {
  return {
    name,
    namespace: NAMESPACE,
    uid: `uid-${name}`,
    generation: revision,
    resourceVersion: String(revision),
    creationTimestamp: "2026-08-28T00:00:00.000Z",
  };
}

function ref(kind: "Session" | "Target", name: string): ResourceRef {
  return {
    apiVersion: API_VERSION,
    kind,
    namespace: NAMESPACE,
    name,
    uid: `uid-${name}`,
  };
}

function session(
  name: string,
  phase: "Active" | "Inactive" = "Active",
): BatonSessionResource {
  return {
    apiVersion: API_VERSION,
    kind: "Session",
    metadata: metadata(name),
    spec: {},
    status: { phase },
  };
}

function target(
  name: string,
  harness = "codex",
  phase: "Ready" | "Unavailable" = "Ready",
): BatonTargetResource {
  return {
    apiVersion: API_VERSION,
    kind: "Target",
    metadata: metadata(name),
    spec: { harness },
    status: { phase },
  };
}

function binding(
  sessionId: string,
  eligibleTargetIds: readonly string[],
  selectedTargetId?: string,
): BatonSessionTargetBindingResource {
  return {
    apiVersion: API_VERSION,
    kind: "SessionTargetBinding",
    metadata: metadata(sessionId),
    spec: {
      sessionRef: ref("Session", sessionId),
      eligibleTargetRefs: eligibleTargetIds.map((name) => ref("Target", name)),
      ...(selectedTargetId
        ? { targetRef: ref("Target", selectedTargetId) }
        : {}),
    },
    status: selectedTargetId
      ? {
          observedGeneration: 1,
          effectiveTargetRef: ref("Target", selectedTargetId),
          phase: "Bound",
        }
      : { observedGeneration: 1, phase: "Pending" },
  };
}

describe("target routing", () => {
  test("chooses the least-used target using active sessions only", () => {
    const targets = [target("codex"), target("codex2"), target("claude", "claude")];
    const current = binding("current", ["codex", "codex2"]);
    const assignment = chooseTarget({
      requestedTarget: targets[0]!,
      currentBinding: current,
      sessions: [
        session("current"),
        session("s1"),
        session("s2"),
        session("old", "Inactive"),
      ],
      targets,
      bindings: [
        current,
        binding("s1", ["codex", "codex2"], "codex"),
        binding("s2", ["codex", "codex2"], "codex"),
        binding("old", ["codex", "codex2"], "codex2"),
      ],
      config: parseTargetBalancerConfig({
        pools: { codex: ["codex", "codex2"] },
      }),
    });

    expect(assignment?.target.metadata.name).toBe("codex2");
    expect(assignment?.loads).toEqual({ codex: 2, codex2: 0 });
  });

  test("keeps explicit and already-bound target choices unchanged", () => {
    const targets = [target("codex"), target("codex2")];
    const current = binding("current", ["codex", "codex2"]);
    const common = {
      sessions: [session("current")],
      targets,
      bindings: [current],
      config: parseTargetBalancerConfig({
        pools: { codex: ["codex", "codex2"] },
      }),
    };

    expect(chooseTarget({
      ...common,
      requestedTarget: targets[1]!,
      currentBinding: current,
    })).toBeUndefined();
    expect(chooseTarget({
      ...common,
      requestedTarget: targets[0]!,
      currentBinding: binding("current", ["codex", "codex2"], "codex2"),
    })).toBeUndefined();
  });

  test("honors eligibility, readiness, and configured pools", () => {
    const targets = [
      target("codex"),
      target("codex2"),
      target("codex3"),
      target("codex4", "codex", "Unavailable"),
    ];
    const current = binding("current", ["codex", "codex2", "codex4"]);
    expect(chooseTarget({
      requestedTarget: targets[0]!,
      currentBinding: current,
      sessions: [session("current")],
      targets,
      bindings: [current],
      config: parseTargetBalancerConfig({
        pools: { codex: ["codex", "codex2", "codex3", "codex4"] },
      }),
    })?.target.metadata.name).toBe("codex");

    expect(chooseTarget({
      requestedTarget: targets[0]!,
      currentBinding: current,
      sessions: [session("current")],
      targets,
      bindings: [current],
      config: parseTargetBalancerConfig({ pools: { claude: ["claude", "claude2"] } }),
    })).toBeUndefined();
  });

  test("does not balance a Harness without an explicit pool", () => {
    const targets = [target("codex"), target("codex2")];
    const current = binding("current", ["codex", "codex2"]);

    expect(chooseTarget({
      requestedTarget: targets[0]!,
      currentBinding: current,
      sessions: [session("current")],
      targets,
      bindings: [current],
      config: parseTargetBalancerConfig({}),
    })).toBeUndefined();
  });

  test("rejects malformed pool configuration", () => {
    expect(() => parseTargetBalancerConfig({ pools: { codex: [] } })).toThrow(
      "config.pools.codex",
    );
    expect(() => parseTargetBalancerConfig({ pools: "codex" })).toThrow(
      "config.pools must be an object",
    );
  });
});
