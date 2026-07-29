import {
  describe,
  expect,
  test,
} from "bun:test";

import type {
  Resource,
  ResourceClient,
  ToastMessage,
} from "@compforge/baton-plugin";

import {
  createRequirementContextProvider,
  createRequirementController,
  getStatusCondition,
  PULL_REQUEST_RESOURCE_TYPE,
  type PullRequestSpec,
  type PullRequestStatus,
  type RequirementConnector,
  REQUIREMENT_CONDITION,
  REQUIREMENT_RESOURCE_TYPE,
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
  let pullRequest:
    | Readonly<Resource<PullRequestSpec, PullRequestStatus>>
    | undefined;
  const client = {
    list(type: { apiVersion: string; kind: string }) {
      if (type.kind === REQUIREMENT_RESOURCE_TYPE.kind) {
        return resource ? [resource] : [];
      }
      if (type.kind === PULL_REQUEST_RESOURCE_TYPE.kind) {
        return pullRequest ? [pullRequest] : [];
      }
      return [resource, pullRequest].filter(Boolean);
    },
    create(
      type: { apiVersion: string; kind: string },
      input: {
        name: string;
        spec: RequirementSpec | PullRequestSpec;
      },
    ) {
      const created = {
        ...type,
        metadata: {
          name: input.name,
          namespace: "pi_reqloop",
          uid: `uid-${input.name}`,
          generation: 1,
          resourceVersion: "1",
          creationTimestamp: "2026-07-26T00:00:00.000Z",
        },
        spec: input.spec,
        status: {},
      };
      if (type.kind === REQUIREMENT_RESOURCE_TYPE.kind) {
        resource = created as unknown as Resource<
          RequirementSpec,
          RequirementStatus
        >;
        return resource;
      }
      pullRequest = created as unknown as Resource<
        PullRequestSpec,
        PullRequestStatus
      >;
      return pullRequest;
    },
    patchStatus(
      current: Readonly<Resource>,
      patch: Record<string, unknown>,
    ) {
      const updated = {
        ...current,
        metadata: {
          ...current.metadata,
          resourceVersion: String(
            Number(current.metadata.resourceVersion) + 1,
          ),
        },
        status: { ...current.status, ...patch },
      };
      if (current.kind === REQUIREMENT_RESOURCE_TYPE.kind) {
        resource = updated as unknown as Resource<
          RequirementSpec,
          RequirementStatus
        >;
        return resource;
      }
      pullRequest = updated as unknown as Resource<
        PullRequestSpec,
        PullRequestStatus
      >;
      return pullRequest;
    },
  } as unknown as ResourceClient;
  return { client, current: () => resource };
}

describe("Requirement Resource", () => {
  test("materializes a selected Requirement and presents it on the Board", async () => {
    const resources = resourceClient();
    const requirement = await upsertRequirement(resources.client, {
      source: "meego",
      category: "story",
      id: "REQ-7",
      title: "Requirement intake",
      state: "in_progress",
      description: "Create a durable Requirement Resource.",
      acceptanceCriteria: ["The Requirement appears on the Board"],
      url: "https://meego.example/story/REQ-7",
    });

    expect({
      apiVersion: requirement.apiVersion,
      kind: requirement.kind,
    }).toEqual(REQUIREMENT_RESOURCE_TYPE);
    expect(requirement.status.externalState).toBe("in_progress");
    expect(requirement.status.observedGeneration).toBe(
      requirement.metadata.generation,
    );
    expect(
      getStatusCondition(
        requirement.status.conditions,
        REQUIREMENT_CONDITION.observed,
      ),
    ).toMatchObject({
      status: "True",
      observedGeneration: requirement.metadata.generation,
      reason: "ObservationSucceeded",
    });
    expect(
      await createRequirementController().present?.(requirement),
    ).toEqual({
      title: "REQ-7",
      url: "https://meego.example/story/REQ-7",
      status: "in_progress",
      detail: "Requirement intake",
      priority: 0,
      tone: "default",
    });
    expect(resources.current()).toEqual(requirement);
  });

  test("provides searchable local Requirement context to one Harness turn", async () => {
    const resources = resourceClient();
    const requirement = await upsertRequirement(resources.client, {
      source: "meego",
      category: "story",
      id: "REQ-7",
      title: "Requirement intake",
      state: "in_progress",
      description: "Create a durable Requirement Resource.",
      acceptanceCriteria: ["The Requirement appears on the Board"],
      assignee: "Owner",
      url: "https://meego.example/story/REQ-7",
    });
    const provider = createRequirementContextProvider(resources.client);

    expect(provider.kind).toBe("requirement");
    expect(await provider.search("durable")).toEqual([{
      id: requirement.metadata.name,
      label: "Requirement intake",
      detail: "meego · story · REQ-7 · in_progress",
    }]);
    expect(await provider.search("issue")).toEqual([]);

    const context = await provider.provide(
      requirement.metadata.name,
      { maxChars: 1_000 },
    );
    expect(context).toContain("Requirement: Requirement intake");
    expect(context).toContain("Category: story");
    expect(context).toContain(
      "Acceptance criteria:\n- The Requirement appears on the Board",
    );
    expect(
      await provider.provide(
        requirement.metadata.name,
        { maxChars: 20 },
      ),
    ).toBe(context?.slice(0, 20));
  });

  test("hides completed Requirements from the Board", async () => {
    const resources = resourceClient();
    const requirement = await upsertRequirement(resources.client, {
      source: "meego",
      category: "story",
      id: "REQ-8",
      title: "Completed work",
      state: "completed",
    });

    expect(
      await createRequirementController().present?.(requirement),
    ).toBeUndefined();
    expect(
      await createRequirementContextProvider(resources.client).search(""),
    ).toEqual([]);
  });

  test("maps PullRequest association changes to Requirement requests", async () => {
    const resources = resourceClient();
    const requirement = await upsertRequirement(resources.client, {
      source: "meego",
      category: "story",
      id: "REQ-WATCH",
      title: "Watch linked pull requests",
      state: "in_progress",
    });
    const pullRequest = await resources.client.create<
      PullRequestSpec,
      PullRequestStatus
    >(PULL_REQUEST_RESOURCE_TYPE, {
      name: "pr_watch",
      spec: {
        identity: {
          source: "github.com",
          repository: "owner/repo",
          number: 11,
        },
      },
    });
    const linked = await resources.client.patchStatus(pullRequest, {
      requirementAssociation: {
        state: "linked",
        requirement: {
          ...REQUIREMENT_RESOURCE_TYPE,
          namespace: requirement.metadata.namespace,
          name: requirement.metadata.name,
          uid: requirement.metadata.uid,
        },
      },
    });
    const moved = {
      ...linked,
      metadata: {
        ...linked.metadata,
        resourceVersion: "3",
      },
      status: {
        ...linked.status,
        requirementAssociation: {
          state: "linked" as const,
          requirement: {
            ...REQUIREMENT_RESOURCE_TYPE,
            namespace: requirement.metadata.namespace,
            name: "req_other",
            uid: "uid-req_other",
          },
        },
      },
    };
    const controller = createRequirementController(resources.client);
    const watch = controller.watches?.[0];

    expect(watch?.resourceType).toBe(PULL_REQUEST_RESOURCE_TYPE);
    expect(await watch?.handler.create({ object: pullRequest })).toEqual([]);
    expect(await watch?.handler.update({
      oldObject: pullRequest,
      newObject: linked,
    })).toEqual([{ name: requirement.metadata.name }]);
    expect(await watch?.handler.create({ object: linked })).toEqual([
      { name: requirement.metadata.name },
    ]);
    expect(await watch?.handler.update({
      oldObject: linked,
      newObject: moved,
    })).toEqual([
      { name: requirement.metadata.name },
      { name: "req_other" },
    ]);
    expect(await watch?.handler.delete({ object: moved })).toEqual([
      { name: "req_other" },
    ]);
  });

  test("refreshes external state and reminds once when linked PRs are done", async () => {
    const resources = resourceClient();
    const requirement = await upsertRequirement(resources.client, {
      source: "meego",
      category: "story",
      id: "REQ-9",
      title: "Close completed requirement",
      state: "in_progress",
      url: "https://meego.example/story/REQ-9",
    });
    const pullRequest = await resources.client.create<
      PullRequestSpec,
      PullRequestStatus
    >(PULL_REQUEST_RESOURCE_TYPE, {
      name: "pr_merged",
      spec: {
        identity: {
          source: "github.com",
          repository: "owner/repo",
          number: 9,
        },
      },
    });
    let linkedPullRequest = await resources.client.patchStatus(pullRequest, {
      lifecycle: "merged",
      reviewThreads: "unknown",
      requirementAssociation: {
        state: "linked",
        requirement: {
          ...REQUIREMENT_RESOURCE_TYPE,
          namespace: requirement.metadata.namespace,
          name: requirement.metadata.name,
          uid: requirement.metadata.uid,
        },
      },
    });
    let observationCalls = 0;
    const connector: RequirementConnector = {
      source: "meego",
      provider: "meego",
      async list() {
        return [];
      },
      async get(identity) {
        observationCalls += 1;
        return {
          ...identity,
          title: "Close completed requirement",
          state: "in_progress",
          url: "https://meego.example/story/REQ-9",
          updatedAt: "2026-07-26T12:00:00.000Z",
        };
      },
    };
    const toasts: ToastMessage[] = [];
    const controller = createRequirementController(
      resources.client,
      [connector],
      { show: (message) => toasts.push(message) },
    );

    expect(controller.sources).toEqual([{
      type: "cron",
      sourceId: "requirement-poll",
      cron: "0 * * * * *",
      timeZone: "UTC",
    }]);
    await controller.reconcile({} as never, requirement);
    expect(resources.current()?.status).toMatchObject({
      externalState: "in_progress",
      updatedAt: "2026-07-26T12:00:00.000Z",
      linkedPullRequests: {
        total: 1,
        open: 0,
        merged: 1,
        conflicted: 0,
        unresolvedReviewThreads: 0,
      },
    });
    expect(
      await controller.present?.(resources.current()!),
    ).toMatchObject({
      status: "in_progress · 1 PR merged",
      tone: "default",
    });
    expect(resources.current()?.status.closeReminderKey).toBeUndefined();
    expect(
      getStatusCondition(
        resources.current()?.status.conditions,
        REQUIREMENT_CONDITION.readyToClose,
      ),
    ).toMatchObject({
      status: "Unknown",
      reason: "ReviewStatusUnknown",
    });
    expect(toasts).toHaveLength(0);

    linkedPullRequest = await resources.client.patchStatus(linkedPullRequest, {
      reviewThreads: "unresolved",
    });
    await controller.reconcile({} as never, resources.current()!);
    expect(
      await controller.present?.(resources.current()!),
    ).toMatchObject({
      status: "in_progress · 1 PR merged · 1 unresolved review",
      priority: 100,
      tone: "warning",
    });
    expect(
      getStatusCondition(
        resources.current()?.status.conditions,
        REQUIREMENT_CONDITION.readyToClose,
      ),
    ).toMatchObject({
      status: "False",
      reason: "UnresolvedReviewThreads",
    });
    expect(toasts).toHaveLength(0);

    linkedPullRequest = await resources.client.patchStatus(linkedPullRequest, {
      reviewThreads: "resolved",
      mergeability: "conflicted",
    });
    await controller.reconcile({} as never, resources.current()!);
    expect(
      await controller.present?.(resources.current()!),
    ).toMatchObject({
      status: "in_progress · 1 PR merged · 1 merge conflict",
      priority: 200,
      tone: "error",
    });

    linkedPullRequest = await resources.client.patchStatus(linkedPullRequest, {
      mergeability: "ready",
    });
    await controller.reconcile({} as never, resources.current()!);
    expect(
      await controller.present?.(resources.current()!),
    ).toMatchObject({
      status: "in_progress · 1 PR merged · Ready to close",
      tone: "default",
    });
    expect(
      getStatusCondition(
        resources.current()?.status.conditions,
        REQUIREMENT_CONDITION.readyToClose,
      ),
    ).toMatchObject({
      status: "True",
      reason: "PullRequestsSettled",
    });
    expect(
      typeof resources.current()?.status.closeReminderKey,
    ).toBe("string");
    expect(toasts).toEqual([{
      text:
        "Requirement \"Close completed requirement\" looks ready to close. " +
        "Please close it at https://meego.example/story/REQ-9.",
      tone: "info",
    }]);

    await controller.reconcile({} as never, resources.current()!);
    expect(toasts).toHaveLength(1);
    expect(observationCalls).toBe(1);
  });

  test("records a failed Requirement observation before retrying", async () => {
    const resources = resourceClient();
    const requirement = await upsertRequirement(resources.client, {
      source: "meego",
      category: "story",
      id: "REQ-FAILED",
      title: "Unavailable requirement",
      state: "in_progress",
    });
    const pullRequest = await resources.client.create<
      PullRequestSpec,
      PullRequestStatus
    >(PULL_REQUEST_RESOURCE_TYPE, {
      name: "pr_observation_failed",
      spec: {
        identity: {
          source: "github.com",
          repository: "owner/repo",
          number: 19,
        },
      },
    });
    await resources.client.patchStatus(pullRequest, {
      lifecycle: "open",
      reviewThreads: "resolved",
      requirementAssociation: {
        state: "linked",
        requirement: {
          ...REQUIREMENT_RESOURCE_TYPE,
          namespace: requirement.metadata.namespace,
          name: requirement.metadata.name,
          uid: requirement.metadata.uid,
        },
      },
    });
    const connector: RequirementConnector = {
      source: "meego",
      provider: "meego",
      async list() {
        return [];
      },
      async get() {
        throw new Error("provider unavailable");
      },
    };
    const controller = createRequirementController(
      resources.client,
      [connector],
    );

    await expect(
      controller.reconcile({} as never, requirement),
    ).rejects.toThrow("provider unavailable");
    expect(
      getStatusCondition(
        resources.current()?.status.conditions,
        REQUIREMENT_CONDITION.observed,
      ),
    ).toMatchObject({
      status: "False",
      reason: "ObservationFailed",
    });
    expect(resources.current()?.status.linkedPullRequests).toEqual({
      total: 1,
      open: 1,
      merged: 0,
      conflicted: 0,
      unresolvedReviewThreads: 0,
    });
  });

  test("does not inherit PullRequests linked to a replaced Requirement", async () => {
    const resources = resourceClient();
    const requirement = await upsertRequirement(resources.client, {
      source: "meego",
      category: "story",
      id: "REQ-REPLACED",
      title: "Replacement requirement",
      state: "in_progress",
    });
    const pullRequest = await resources.client.create<
      PullRequestSpec,
      PullRequestStatus
    >(PULL_REQUEST_RESOURCE_TYPE, {
      name: "pr_old_requirement",
      spec: {
        identity: {
          source: "github.com",
          repository: "owner/repo",
          number: 20,
        },
      },
    });
    await resources.client.patchStatus(pullRequest, {
      lifecycle: "merged",
      reviewThreads: "resolved",
      requirementAssociation: {
        state: "linked",
        requirement: {
          ...REQUIREMENT_RESOURCE_TYPE,
          namespace: requirement.metadata.namespace,
          name: requirement.metadata.name,
          uid: "uid-deleted-requirement",
        },
      },
    });

    await createRequirementController(resources.client).reconcile(
      {} as never,
      requirement,
    );

    expect(resources.current()?.status.linkedPullRequests?.total).toBe(0);
  });

  test("ignores linked closed PullRequests in the Requirement projection", async () => {
    const resources = resourceClient();
    const requirement = await upsertRequirement(resources.client, {
      source: "meego",
      category: "story",
      id: "REQ-10",
      title: "Ignore abandoned delivery",
      state: "in_progress",
    });
    const pullRequest = await resources.client.create<
      PullRequestSpec,
      PullRequestStatus
    >(PULL_REQUEST_RESOURCE_TYPE, {
      name: "pr_closed",
      spec: {
        identity: {
          source: "github.com",
          repository: "owner/repo",
          number: 10,
        },
      },
    });
    await resources.client.patchStatus(pullRequest, {
      lifecycle: "closed",
      reviewThreads: "resolved",
      requirementAssociation: {
        state: "linked",
        requirement: {
          ...REQUIREMENT_RESOURCE_TYPE,
          namespace: requirement.metadata.namespace,
          name: requirement.metadata.name,
          uid: requirement.metadata.uid,
        },
      },
    });
    const toasts: ToastMessage[] = [];
    const controller = createRequirementController(
      resources.client,
      [],
      { show: (message) => toasts.push(message) },
    );

    await controller.reconcile({} as never, requirement);

    expect(resources.current()?.status.linkedPullRequests).toEqual({
      total: 0,
      open: 0,
      merged: 0,
      conflicted: 0,
      unresolvedReviewThreads: 0,
    });
    expect(
      getStatusCondition(
        resources.current()?.status.conditions,
        REQUIREMENT_CONDITION.readyToClose,
      ),
    ).toMatchObject({
      status: "False",
      reason: "NoLinkedPullRequests",
    });
    expect(
      await controller.present?.(resources.current()!),
    ).toMatchObject({
      status: "in_progress",
      tone: "default",
    });
    expect(toasts).toHaveLength(0);
  });
});
