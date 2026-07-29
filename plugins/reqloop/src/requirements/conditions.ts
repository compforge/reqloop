import type { ResourceCondition } from "@compforge/baton-plugin";

import type { RequirementStatus } from "./protocol.ts";

export const REQUIREMENT_CONDITION = Object.freeze({
  observed: "Observed",
  readyToClose: "ReadyToClose",
  closureRequested: "ClosureRequested",
} as const);

export type StatusConditionUpdate = Omit<
  ResourceCondition,
  "lastTransitionTime"
>;

function sameCondition(
  left: ResourceCondition,
  right: ResourceCondition,
): boolean {
  return (
    left.type === right.type &&
    left.status === right.status &&
    left.observedGeneration === right.observedGeneration &&
    left.lastTransitionTime === right.lastTransitionTime &&
    left.reason === right.reason &&
    left.message === right.message
  );
}

/**
 * Returns a new condition list when facts changed and preserves the original
 * list otherwise. Only a tri-state status transition advances transition time.
 */
export function setStatusCondition(
  conditions: readonly ResourceCondition[] | undefined,
  update: StatusConditionUpdate,
  transitionTime = new Date().toISOString(),
): readonly ResourceCondition[] {
  const currentConditions = conditions ?? [];
  const index = currentConditions.findIndex(
    (condition) => condition.type === update.type,
  );
  if (index < 0) {
    return [
      ...currentConditions,
      { ...update, lastTransitionTime: transitionTime },
    ];
  }

  const current = currentConditions[index]!;
  const next = {
    ...update,
    lastTransitionTime: current.status === update.status
      ? current.lastTransitionTime
      : transitionTime,
  } satisfies ResourceCondition;
  if (sameCondition(current, next)) return currentConditions;

  return currentConditions.map((condition, conditionIndex) =>
    conditionIndex === index ? next : condition
  );
}

export function getStatusCondition(
  conditions: readonly ResourceCondition[] | undefined,
  type: string,
): ResourceCondition | undefined {
  return conditions?.find((condition) => condition.type === type);
}

/** Local closure is terminal for reqloop without claiming the provider closed. */
export function isRequirementActive(status: RequirementStatus): boolean {
  return (
    status.externalState !== "completed" &&
    status.externalState !== "closed" &&
    getStatusCondition(
      status.conditions,
      REQUIREMENT_CONDITION.closureRequested,
    )?.status !== "True"
  );
}
