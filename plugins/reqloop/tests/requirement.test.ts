import {
  describe,
  expect,
  test,
} from "bun:test";

import type {
  Resource,
  ResourceClient,
} from "@qiankun01/baton-plugin";

import {
  createRequirementController,
  REQUIREMENT_RESOURCE_KIND,
  type RequirementSpec,
  type RequirementStatus,
  upsertRequirement,
} from "../src/index.ts";

function resourceClient(): {
  readonly client: ResourceClient;
  readonly current: () => Readonly<
    Resource<RequirementSpec, RequirementStatus>
  > | undefined;
} {
  let resource:
    | Readonly<Resource<RequirementSpec, RequirementStatus>>
    | undefined;
  const client = {
    list(kind?: string) {
      return kind === REQUIREMENT_RESOURCE_KIND && resource ? [resource] : [];
    },
    create(
      kind: string,
      input: { resourceId: string; spec: RequirementSpec },
    ) {
      resource = {
        kind,
        metadata: {
          resourceId: input.resourceId,
          batonSessionId: "bs_test",
          pluginInstanceId: "pi_reqloop",
          generation: 1,
          resourceVersion: 1,
          createdAt: "2026-07-26T00:00:00.000Z",
          updatedAt: "2026-07-26T00:00:00.000Z",
        },
        spec: input.spec,
        status: {} as RequirementStatus,
      };
      return resource;
    },
    patchStatus(
      current: Readonly<Resource<RequirementSpec, RequirementStatus>>,
      patch: Partial<RequirementStatus>,
    ) {
      resource = {
        ...current,
        status: { ...current.status, ...patch },
      };
      return resource;
    },
  } as unknown as ResourceClient;
  return { client, current: () => resource };
}

describe("Requirement Resource", () => {
  test("materializes a selected Requirement and presents it on the Board", () => {
    const resources = resourceClient();
    const requirement = upsertRequirement(resources.client, {
      source: "meego",
      category: "story",
      id: "REQ-7",
      title: "Requirement intake",
      state: "in_progress",
      description: "Create a durable Requirement Resource.",
      acceptanceCriteria: ["The Requirement appears on the Board"],
    });

    expect(requirement.kind).toBe(REQUIREMENT_RESOURCE_KIND);
    expect(requirement.status.externalState).toBe("in_progress");
    expect(createRequirementController().present?.(requirement)).toEqual({
      title: "Requirement intake",
      status: "in_progress",
      detail: "Create a durable Requirement Resource.",
      tone: "default",
    });
    expect(resources.current()).toEqual(requirement);
  });

  test("hides completed Requirements from the Board", () => {
    const resources = resourceClient();
    const requirement = upsertRequirement(resources.client, {
      source: "meego",
      category: "story",
      id: "REQ-8",
      title: "Completed work",
      state: "completed",
    });

    expect(
      createRequirementController().present?.(requirement),
    ).toBeUndefined();
  });
});
