import type { Controller } from "@qiankun01/baton-plugin";

import type {
  RequirementSpec,
  RequirementStatus,
} from "./protocol.ts";
import { REQUIREMENT_RESOURCE_KIND } from "./resource.ts";

export function createRequirementController(): Controller<
  RequirementSpec,
  RequirementStatus
> {
  return {
    resourceKind: REQUIREMENT_RESOURCE_KIND,
    async reconcile() {},
    present(resource) {
      const state = resource.status.externalState;
      if (state === "completed" || state === "closed") return undefined;
      return {
        title: resource.spec.title,
        status: state ?? "Not observed",
        ...(resource.spec.description
          ? { detail: resource.spec.description }
          : {}),
        tone: state === "unknown" ? "muted" : "default",
      };
    },
  };
}
