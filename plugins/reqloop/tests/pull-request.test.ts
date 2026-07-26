import {
  describe,
  expect,
  test,
} from "bun:test";

import type {
  BatonSnapshot,
  Resource,
  ResourceClient,
} from "@qiankun01/baton-plugin";

import {
  createPullRequestController,
  type ForgeConnector,
  PULL_REQUEST_RESOURCE_KIND,
  pullRequestResourceId,
  type PullRequestObservation,
  type PullRequestSpec,
  type PullRequestStatus,
  REQUIREMENT_RESOURCE_KIND,
  type RequirementSpec,
  type RequirementStatus,
  upsertPullRequestObservation,
} from "../src/index.ts";

function resourceClient(): {
  readonly client: ResourceClient;
  readonly current: () => Readonly<
    Resource<PullRequestSpec, PullRequestStatus>
  > | undefined;
  readonly addRequirement: (resourceId?: string) => void;
} {
  let resource:
    | Readonly<Resource<PullRequestSpec, PullRequestStatus>>
    | undefined;
  let requirement:
    | Readonly<Resource<RequirementSpec, RequirementStatus>>
    | undefined;
  const client = {
    list(kind?: string) {
      if (kind === REQUIREMENT_RESOURCE_KIND) {
        return requirement ? [requirement] : [];
      }
      if (kind === PULL_REQUEST_RESOURCE_KIND) {
        return resource ? [resource] : [];
      }
      return [resource, requirement].filter(Boolean);
    },
    create(
      kind: string,
      input: { resourceId: string; spec: PullRequestSpec },
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
        status: {},
      };
      return resource;
    },
    patchStatus(
      current: Readonly<Resource<PullRequestSpec, PullRequestStatus>>,
      patch: Partial<PullRequestStatus>,
    ) {
      const status = { ...current.status, ...patch };
      if (JSON.stringify(current.status) === JSON.stringify(status)) {
        return current;
      }
      resource = {
        ...current,
        metadata: {
          ...current.metadata,
          resourceVersion: current.metadata.resourceVersion + 1,
        },
        status,
      };
      return resource;
    },
  } as unknown as ResourceClient;
  return {
    client,
    current: () => resource,
    addRequirement(resourceId = "req_active") {
      requirement = {
        kind: REQUIREMENT_RESOURCE_KIND,
        metadata: {
          resourceId,
          batonSessionId: "bs_test",
          pluginInstanceId: "pi_reqloop",
          generation: 1,
          resourceVersion: 1,
          createdAt: "2026-07-26T00:00:00.000Z",
          updatedAt: "2026-07-26T00:00:00.000Z",
        },
        spec: {
          identity: {
            source: "meego",
            category: "story",
            id: "REQ-7",
          },
          title: "Requirement intake",
        },
        status: { externalState: "in_progress" },
      };
    },
  };
}

function batonSnapshot(
  pluginInteractions: BatonSnapshot["pluginInteractions"] = [],
): BatonSnapshot {
  return {
    session: {
      batonSessionId: "bs_test",
      runState: "idle",
      revision: 0,
    },
    activeTurns: [],
    inputs: [],
    harnessTargets: [],
    pendingInteractions: [],
    pluginInteractions,
    turns: [],
  };
}

const observation: PullRequestObservation = {
  identity: {
    source: "github-primary",
    repository: "qiankunli/reqloop",
    number: 17,
  },
  lifecycle: "open",
  reviewThreads: "unresolved",
  mergeability: "ready",
  observedAt: "2026-07-26T08:00:00.000Z",
};

describe("PullRequest Resource", () => {
  test("uses one stable Resource for repeated external observations", () => {
    const resources = resourceClient();

    const created = upsertPullRequestObservation(
      resources.client,
      observation,
    );
    const repeated = upsertPullRequestObservation(
      resources.client,
      observation,
    );

    expect(created.kind).toBe(PULL_REQUEST_RESOURCE_KIND);
    expect(created.metadata.resourceId).toBe(
      pullRequestResourceId(observation.identity),
    );
    expect(created.spec).toEqual({ identity: observation.identity });
    expect(created.status).toEqual({
      lifecycle: "open",
      reviewThreads: "unresolved",
      reviewActivityKey: null,
      mergeability: "ready",
      observedAt: "2026-07-26T08:00:00.000Z",
    });
    expect(repeated.metadata.resourceVersion).toBe(
      created.metadata.resourceVersion,
    );
    expect(resources.current()).toEqual(repeated);
  });

  test("shows only standalone open PullRequests on the Board", () => {
    const controller = createPullRequestController();
    const resources = resourceClient();
    const pullRequest = upsertPullRequestObservation(
      resources.client,
      observation,
    );

    expect(controller.resourceKind).toBe(PULL_REQUEST_RESOURCE_KIND);
    expect(controller.present?.(pullRequest)).toEqual({
      title: "qiankunli/reqloop #17",
      status: "Unresolved review threads",
      detail: "Standalone PullRequest",
      tone: "warning",
    });
    expect(controller.present?.({
      ...pullRequest,
      status: {
        ...pullRequest.status,
        requirementAssociation: {
          state: "linked",
          requirement: {
            resourceKind: REQUIREMENT_RESOURCE_KIND,
            resourceId: "req_active",
            resourceOwner: "plugin",
          },
        },
      },
    })).toBeUndefined();
    expect(controller.present?.({
      ...pullRequest,
      status: { ...pullRequest.status, lifecycle: "merged" },
    })).toBeUndefined();
  });

  test("refreshes a PullRequest through its configured Forge", async () => {
    const resources = resourceClient();
    const pullRequest = upsertPullRequestObservation(
      resources.client,
      observation,
    );
    const forge: ForgeConnector = {
      source: "github-primary",
      provider: "github",
      async list() {
        return [];
      },
      async get(identity) {
        return {
          identity,
          lifecycle: "merged",
          reviewThreads: "resolved",
          mergeability: "ready",
          observedAt: "2026-07-26T10:00:00.000Z",
        };
      },
    };
    const controller = createPullRequestController(
      resources.client,
      [forge],
    );

    expect(controller.sources).toEqual([{
      type: "cron",
      sourceId: "pull-request-poll",
      cron: "*/30 * * * * *",
      timeZone: "UTC",
    }]);
    await controller.reconcile({} as never, pullRequest);
    expect(resources.current()?.status).toEqual({
      lifecycle: "merged",
      reviewThreads: "resolved",
      reviewActivityKey: null,
      mergeability: "ready",
      observedAt: "2026-07-26T10:00:00.000Z",
    });
  });

  test("asks once whether a PullRequest joins a Requirement", async () => {
    const resources = resourceClient();
    resources.addRequirement();
    const pullRequest = upsertPullRequestObservation(
      resources.client,
      observation,
    );
    const controller = createPullRequestController(resources.client);

    const prompted = await controller.reconcile(
      batonSnapshot(),
      pullRequest,
    );
    expect(prompted?.output).toMatchObject({
      kind: "interaction",
      title: "Associate pull request",
      options: [
        {
          optionId: "requirement:req_active",
          label: "Requirement intake",
        },
        {
          optionId: "standalone",
          label: "Keep standalone",
          role: "reject",
        },
      ],
    });
    expect(resources.current()?.status.requirementAssociation).toEqual({
      state: "prompted",
      decisionKey: expect.any(String),
    });
    if (prompted?.output?.kind !== "interaction") {
      throw new Error("expected association Interaction");
    }

    const current = resources.current()!;
    await controller.reconcile(
      batonSnapshot([{
        interactionId: "ix_associate",
        decisionKey: prompted.output.decisionKey,
        resource: {
          resourceKind: PULL_REQUEST_RESOURCE_KIND,
          resourceId: current.metadata.resourceId,
          resourceOwner: "plugin",
        },
        outcome: {
          kind: "answered",
          values: ["requirement:req_active"],
        },
      }]),
      current,
    );
    expect(resources.current()?.status.requirementAssociation).toEqual({
      state: "linked",
      requirement: {
        resourceKind: REQUIREMENT_RESOURCE_KIND,
        resourceId: "req_active",
        resourceOwner: "plugin",
      },
    });
    expect(controller.present?.(resources.current()!)).toBeUndefined();
  });

  test("does not poll a merged PullRequest again", async () => {
    const resources = resourceClient();
    const merged = upsertPullRequestObservation(resources.client, {
      ...observation,
      lifecycle: "merged",
    });
    let calls = 0;
    const forge: ForgeConnector = {
      source: "github-primary",
      provider: "github",
      async list() {
        return [];
      },
      async get() {
        calls += 1;
        return observation;
      },
    };

    await createPullRequestController(
      resources.client,
      [forge],
    ).reconcile(batonSnapshot(), merged);

    expect(calls).toBe(0);
  });
});
