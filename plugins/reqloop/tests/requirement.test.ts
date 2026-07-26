import {
  describe,
  expect,
  test,
} from "bun:test";

import type {
  Resource,
  ResourceClient,
  ToastMessage,
} from "@qiankun01/baton-plugin";

import {
  createRequirementContextProvider,
  createRequirementController,
  PULL_REQUEST_RESOURCE_KIND,
  type PullRequestSpec,
  type PullRequestStatus,
  type RequirementConnector,
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
  let pullRequest:
    | Readonly<Resource<PullRequestSpec, PullRequestStatus>>
    | undefined;
  const client = {
    list(kind?: string) {
      if (kind === REQUIREMENT_RESOURCE_KIND) {
        return resource ? [resource] : [];
      }
      if (kind === PULL_REQUEST_RESOURCE_KIND) {
        return pullRequest ? [pullRequest] : [];
      }
      return [resource, pullRequest].filter(Boolean);
    },
    create(
      kind: string,
      input: {
        resourceId: string;
        spec: RequirementSpec | PullRequestSpec;
      },
    ) {
      const created = {
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
      if (kind === REQUIREMENT_RESOURCE_KIND) {
        resource = created as Resource<
          RequirementSpec,
          RequirementStatus
        >;
        return resource;
      }
      pullRequest = created as Resource<
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
          resourceVersion: current.metadata.resourceVersion + 1,
        },
        status: { ...current.status, ...patch },
      };
      if (current.kind === REQUIREMENT_RESOURCE_KIND) {
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

  test("provides searchable local Requirement context to one Harness turn", async () => {
    const resources = resourceClient();
    const requirement = upsertRequirement(resources.client, {
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
    expect(provider.search("durable")).toEqual([{
      id: requirement.metadata.resourceId,
      label: "Requirement intake",
      detail: "meego · story · REQ-7 · in_progress",
    }]);
    expect(provider.search("issue")).toEqual([]);

    const context = await provider.provide(
      requirement.metadata.resourceId,
      { maxChars: 1_000 },
    );
    expect(context).toContain("Requirement: Requirement intake");
    expect(context).toContain("Category: story");
    expect(context).toContain(
      "Acceptance criteria:\n- The Requirement appears on the Board",
    );
    expect(
      await provider.provide(
        requirement.metadata.resourceId,
        { maxChars: 20 },
      ),
    ).toBe(context?.slice(0, 20));
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
    expect(
      createRequirementContextProvider(resources.client).search(""),
    ).toEqual([]);
  });

  test("refreshes external state and reminds once when linked PRs are done", async () => {
    const resources = resourceClient();
    const requirement = upsertRequirement(resources.client, {
      source: "meego",
      category: "story",
      id: "REQ-9",
      title: "Close completed requirement",
      state: "in_progress",
      url: "https://meego.example/story/REQ-9",
    });
    const pullRequest = resources.client.create<
      PullRequestSpec,
      PullRequestStatus
    >(PULL_REQUEST_RESOURCE_KIND, {
      resourceId: "pr_merged",
      spec: {
        identity: {
          source: "github.com",
          repository: "owner/repo",
          number: 9,
        },
      },
    });
    const linkedPullRequest = resources.client.patchStatus(pullRequest, {
      lifecycle: "merged",
      reviewThreads: "unresolved",
      requirementAssociation: {
        state: "linked",
        requirement: {
          resourceKind: REQUIREMENT_RESOURCE_KIND,
          resourceId: requirement.metadata.resourceId,
          resourceOwner: "plugin",
        },
      },
    });
    const connector: RequirementConnector = {
      source: "meego",
      provider: "meego",
      async list() {
        return [];
      },
      async get(identity) {
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
        unresolvedReviewThreads: 1,
      },
    });
    expect(controller.present?.(resources.current()!)).toMatchObject({
      status: "in_progress · 1 PR merged · 1 unresolved review",
      tone: "warning",
    });
    expect(resources.current()?.status.closeReminderKey).toBeUndefined();
    expect(toasts).toHaveLength(0);

    resources.client.patchStatus(linkedPullRequest, {
      reviewThreads: "resolved",
    });
    await controller.reconcile({} as never, resources.current()!);
    expect(controller.present?.(resources.current()!)).toMatchObject({
      status: "in_progress · 1 PR merged",
      tone: "default",
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
  });

  test("ignores linked closed PullRequests in the Requirement projection", async () => {
    const resources = resourceClient();
    const requirement = upsertRequirement(resources.client, {
      source: "meego",
      category: "story",
      id: "REQ-10",
      title: "Ignore abandoned delivery",
      state: "in_progress",
    });
    const pullRequest = resources.client.create<
      PullRequestSpec,
      PullRequestStatus
    >(PULL_REQUEST_RESOURCE_KIND, {
      resourceId: "pr_closed",
      spec: {
        identity: {
          source: "github.com",
          repository: "owner/repo",
          number: 10,
        },
      },
    });
    resources.client.patchStatus(pullRequest, {
      lifecycle: "closed",
      reviewThreads: "resolved",
      requirementAssociation: {
        state: "linked",
        requirement: {
          resourceKind: REQUIREMENT_RESOURCE_KIND,
          resourceId: requirement.metadata.resourceId,
          resourceOwner: "plugin",
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
    expect(controller.present?.(resources.current()!)).toMatchObject({
      status: "in_progress",
      tone: "default",
    });
    expect(toasts).toHaveLength(0);
  });
});
