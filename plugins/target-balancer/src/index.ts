import { mkdir, rmdir, stat } from "node:fs/promises";
import { join } from "node:path";

import type {
  BatonSessionResource,
  BatonSessionTargetBindingResource,
  BatonTargetResource,
  PluginContext,
  PluginPackage,
  ResourceRef,
} from "@compforge/baton-plugin";

import {
  chooseTarget,
  isDefaultTarget,
  parseTargetBalancerConfig,
} from "./routing.ts";

const BATON_SESSION = Object.freeze({
  apiVersion: "baton.dev/v1alpha1",
  kind: "Session",
} as const);
const BATON_TARGET = Object.freeze({
  apiVersion: "baton.dev/v1alpha1",
  kind: "Target",
} as const);
const BATON_SESSION_TARGET_BINDING = Object.freeze({
  apiVersion: "baton.dev/v1alpha1",
  kind: "SessionTargetBinding",
} as const);

const LOCK_WAIT_MS = 1_000;
const LOCK_STALE_MS = 10_000;
const LOCK_RETRY_MS = 25;

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code;
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function targetRef(target: BatonTargetResource): ResourceRef {
  return {
    ...BATON_TARGET,
    namespace: target.metadata.namespace,
    name: target.metadata.name,
    uid: target.metadata.uid,
  };
}

function currentBinding(
  bindings: readonly BatonSessionTargetBindingResource[],
  batonSessionId: string,
): BatonSessionTargetBindingResource | undefined {
  return bindings.find((binding) =>
    binding.spec.sessionRef.name === batonSessionId
  );
}

async function acquireLock(path: string): Promise<boolean> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (Date.now() < deadline) {
    try {
      await mkdir(path);
      return true;
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
    }

    try {
      const lock = await stat(path);
      if (Date.now() - lock.mtimeMs > LOCK_STALE_MS) {
        await rmdir(path);
        continue;
      }
    } catch (error) {
      if (!hasCode(error, "ENOENT") && !hasCode(error, "ENOTEMPTY")) {
        throw error;
      }
    }
    await sleep(LOCK_RETRY_MS);
  }
  return false;
}

async function withAssignmentLock(
  context: PluginContext,
  run: () => Promise<void>,
): Promise<void> {
  await mkdir(context.dataDirs.global, { recursive: true });
  const path = join(context.dataDirs.global, ".target-assignment.lock");
  if (!await acquireLock(path)) {
    context.logger.warn("Target assignment lock timed out; keeping default routing", {
      component: "target-balancer.assignment",
      attributes: { batonSessionId: context.session.batonSessionId },
    });
    return;
  }

  try {
    await run();
  } finally {
    try {
      await rmdir(path);
    } catch (error) {
      if (!hasCode(error, "ENOENT")) {
        context.logger.warn("Failed to release target assignment lock", {
          component: "target-balancer.assignment",
          error,
        });
      }
    }
  }
}

const targetBalancer: PluginPackage = Object.freeze({
  pluginId: "compforge/target-balancer",
  version: "0.1.0",

  async activate(context: PluginContext): Promise<void> {
    const config = parseTargetBalancerConfig(context.instance.config);

    context.hooks.register({
      hookId: "assign-least-loaded-target",
      stage: "view.input",
      timeoutMs: 3_000,
      async run(hook): Promise<void> {
        if (hook.subject.input.kind !== "prompt") return;
        const requestedTargetId = hook.subject.input.harnessTargetId;

        const initialTargets = await context.resources.list<
          BatonTargetResource["spec"],
          BatonTargetResource["status"]
        >(BATON_TARGET) as readonly BatonTargetResource[];
        const requestedTarget = initialTargets.find((target) =>
          target.metadata.name === requestedTargetId
        );
        if (!requestedTarget || !isDefaultTarget(requestedTarget)) return;

        const initialBindings = await context.resources.list<
          BatonSessionTargetBindingResource["spec"],
          BatonSessionTargetBindingResource["status"]
        >(BATON_SESSION_TARGET_BINDING) as readonly BatonSessionTargetBindingResource[];
        const initialBinding = currentBinding(
          initialBindings,
          context.session.batonSessionId,
        );
        if (
          !initialBinding ||
          initialBinding.spec.targetRef ||
          initialBinding.status.effectiveTargetRef
        ) {
          return;
        }

        await withAssignmentLock(context, async () => {
          const [sessions, targets, bindings] = await Promise.all([
            context.resources.list<
              BatonSessionResource["spec"],
              BatonSessionResource["status"]
            >(BATON_SESSION) as Promise<readonly BatonSessionResource[]>,
            context.resources.list<
              BatonTargetResource["spec"],
              BatonTargetResource["status"]
            >(BATON_TARGET) as Promise<readonly BatonTargetResource[]>,
            context.resources.list<
              BatonSessionTargetBindingResource["spec"],
              BatonSessionTargetBindingResource["status"]
            >(BATON_SESSION_TARGET_BINDING) as Promise<
              readonly BatonSessionTargetBindingResource[]
            >,
          ]);
          const binding = currentBinding(
            bindings,
            context.session.batonSessionId,
          );
          const freshRequestedTarget = targets.find((target) =>
            target.metadata.name === requestedTargetId
          );
          if (!binding || !freshRequestedTarget) return;

          const assignment = chooseTarget({
            requestedTarget: freshRequestedTarget,
            currentBinding: binding,
            sessions,
            targets,
            bindings,
            config,
          });
          if (!assignment) return;

          await context.resources.patch(binding, {
            type: "merge",
            value: { spec: { targetRef: targetRef(assignment.target) } },
          });
          context.logger.info("Assigned Session to the least-loaded target", {
            component: "target-balancer.assignment",
            attributes: {
              batonSessionId: context.session.batonSessionId,
              harness: freshRequestedTarget.spec.harness,
              requestedTargetId: freshRequestedTarget.metadata.name,
              selectedTargetId: assignment.target.metadata.name,
              loads: assignment.loads,
            },
          });
        });
      },
    });
  },
});

export default targetBalancer;
