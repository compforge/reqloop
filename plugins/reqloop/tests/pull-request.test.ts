import {
  describe,
  expect,
  test,
} from "bun:test";

import type {
  BatonSnapshot,
  Resource,
  ResourceClient,
} from "@compforge/baton-plugin";

import {
  createRepositoryController,
  createPullRequestController,
  REPOSITORY_RESOURCE_TYPE,
  type ForgeConnector,
  type RepositorySpec,
  type RepositoryStatus,
  PULL_REQUEST_RESOURCE_TYPE,
  pullRequestResourceId,
  type PullRequest,
  type PullRequestReviewConnector,
  type PullRequestSpec,
  type PullRequestStatus,
  REQUIREMENT_RESOURCE_TYPE,
  type RequirementSpec,
  type RequirementStatus,
  upsertPullRequest,
  WORKSPACE_RESOURCE_TYPE,
  type WorkspaceSpec,
  type WorkspaceStatus,
} from "../src/index.ts";

function resourceClient(): {
  readonly client: ResourceClient;
  readonly current: () => Readonly<
    Resource<PullRequestSpec, PullRequestStatus>
  > | undefined;
  readonly repositoryCurrent: () => Readonly<
    Resource<RepositorySpec, RepositoryStatus>
  > | undefined;
  readonly addRequirement: (name?: string) => void;
  readonly observeRepository: (
    repository: Readonly<Resource<RepositorySpec, RepositoryStatus>>,
  ) => void;
  readonly workspaceCurrent: () => Readonly<
    Resource<WorkspaceSpec, WorkspaceStatus>
  > | undefined;
  readonly clearWorkspace: () => void;
} {
  let resource:
    | Readonly<Resource<PullRequestSpec, PullRequestStatus>>
    | undefined;
  let requirement:
    | Readonly<Resource<RequirementSpec, RequirementStatus>>
    | undefined;
  let repository:
    | Readonly<Resource<RepositorySpec, RepositoryStatus>>
    | undefined;
  let workspace:
    | Readonly<Resource<WorkspaceSpec, WorkspaceStatus>>
    | undefined;
  const client = {
    list(type: { apiVersion: string; kind: string }) {
      if (type.kind === REQUIREMENT_RESOURCE_TYPE.kind) {
        return requirement ? [requirement] : [];
      }
      if (type.kind === PULL_REQUEST_RESOURCE_TYPE.kind) {
        return resource ? [resource] : [];
      }
      if (type.kind === REPOSITORY_RESOURCE_TYPE.kind) {
        return repository ? [repository] : [];
      }
      if (type.kind === WORKSPACE_RESOURCE_TYPE.kind) {
        return workspace ? [workspace] : [];
      }
      return [resource, requirement, repository, workspace].filter(Boolean);
    },
    create(
      type: { apiVersion: string; kind: string },
      input: {
        name: string;
        spec: PullRequestSpec | RepositorySpec;
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
      if (type.kind === REPOSITORY_RESOURCE_TYPE.kind) {
        repository = created as Resource<
          RepositorySpec,
          RepositoryStatus
        >;
        return repository;
      }
      resource = created as Resource<
        PullRequestSpec,
        PullRequestStatus
      >;
      return resource;
    },
    patchStatus(
      current: Readonly<Resource>,
      patch: Record<string, unknown>,
    ) {
      const status = { ...current.status, ...patch };
      if (JSON.stringify(current.status) === JSON.stringify(status)) {
        return current;
      }
      const updated = {
        ...current,
        metadata: {
          ...current.metadata,
          resourceVersion: String(
            Number(current.metadata.resourceVersion) + 1,
          ),
        },
        status,
      };
      if (current.kind === REPOSITORY_RESOURCE_TYPE.kind) {
        repository = updated as unknown as Resource<
          RepositorySpec,
          RepositoryStatus
        >;
        return repository;
      }
      resource = updated as unknown as Resource<
        PullRequestSpec,
        PullRequestStatus
      >;
      return resource;
    },
  } as unknown as ResourceClient;
  return {
    client,
    current: () => resource,
    repositoryCurrent: () => repository,
    workspaceCurrent: () => workspace,
    addRequirement(name = "req_active") {
      requirement = {
        ...REQUIREMENT_RESOURCE_TYPE,
        metadata: {
          name,
          namespace: "pi_reqloop",
          uid: `uid-${name}`,
          generation: 1,
          resourceVersion: "1",
          creationTimestamp: "2026-07-26T00:00:00.000Z",
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
    observeRepository(observed) {
      workspace = {
        ...WORKSPACE_RESOURCE_TYPE,
        metadata: {
          name: "workspace",
          namespace: observed.metadata.namespace,
          uid: "uid-workspace",
          generation: 1,
          resourceVersion: "1",
          creationTimestamp: "2026-07-26T00:00:00.000Z",
        },
        spec: { root: { kind: "session-cwd" } },
        status: {
          repositories: [{
            relativePath: ".",
            repository: {
              apiVersion: observed.apiVersion,
              kind: observed.kind,
              namespace: observed.metadata.namespace,
              name: observed.metadata.name,
              uid: observed.metadata.uid,
            },
          }],
        },
      };
    },
    clearWorkspace() {
      if (!workspace) return;
      workspace = {
        ...workspace,
        metadata: {
          ...workspace.metadata,
          resourceVersion: String(
            Number(workspace.metadata.resourceVersion) + 1,
          ),
        },
        status: { repositories: [] },
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

const observation: PullRequest = {
  identity: {
    source: "github-primary",
    repository: "compforge/reqloop",
    number: 17,
  },
  lifecycle: "open",
  reviewThreads: "unresolved",
  mergeability: "ready",
  observedAt: "2026-07-26T08:00:00.000Z",
};

describe("PullRequest Resource", () => {
  test("uses one stable Resource for repeated external observations", async () => {
    const resources = resourceClient();

    const created = await upsertPullRequest(
      resources.client,
      observation,
    );
    const repeated = await upsertPullRequest(
      resources.client,
      observation,
    );

    expect({
      apiVersion: created.apiVersion,
      kind: created.kind,
    }).toEqual(PULL_REQUEST_RESOURCE_TYPE);
    expect(created.metadata.name).toBe(
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

  test("shows only standalone open PullRequests on the Board", async () => {
    const controller = createPullRequestController();
    const resources = resourceClient();
    const pullRequest = await upsertPullRequest(
      resources.client,
      observation,
    );

    expect(controller.resourceType).toBe(PULL_REQUEST_RESOURCE_TYPE);
    expect(await controller.present?.(pullRequest)).toEqual({
      title: "compforge/reqloop #17",
      status: "Unresolved review threads",
      detail: "Unassociated PullRequest",
      tone: "warning",
    });
    expect(await controller.present?.({
      ...pullRequest,
      status: {
        ...pullRequest.status,
        requirementAssociation: {
          state: "linked",
          requirement: {
            ...REQUIREMENT_RESOURCE_TYPE,
            namespace: "pi_reqloop",
            name: "req_active",
            uid: "uid-req_active",
          },
        },
      },
    })).toBeUndefined();
    expect(await controller.present?.({
      ...pullRequest,
      status: { ...pullRequest.status, lifecycle: "merged" },
    })).toBeUndefined();
  });

  test("refreshes a PullRequest through its configured Forge", async () => {
    const resources = resourceClient();
    const pullRequest = await upsertPullRequest(
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
    const pullRequest = await upsertPullRequest(
      resources.client,
      observation,
    );
    const controller = createPullRequestController(resources.client);
    const requirement = (await resources.client.list<
      RequirementSpec,
      RequirementStatus
    >(REQUIREMENT_RESOURCE_TYPE))[0]!;

    expect(controller.watches?.[0]?.resourceType).toBe(
      REQUIREMENT_RESOURCE_TYPE,
    );
    expect(
      await controller.watches?.[0]?.handler.create({ object: requirement }),
    ).toEqual([{ name: pullRequest.metadata.name }]);

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
    expect(
      resources.current()?.status.requirementAssociation,
    ).toBeUndefined();
    if (prompted?.output?.kind !== "interaction") {
      throw new Error("expected association Interaction");
    }
    expect(
      await controller.reconcile(batonSnapshot(), resources.current()!),
    ).toMatchObject({
      output: {
        kind: "interaction",
        decisionKey: prompted.output.decisionKey,
      },
    });

    const current = resources.current()!;
    await controller.reconcile(
      batonSnapshot([{
        interactionId: "ix_associate",
        decisionKey: prompted.output.decisionKey,
        resource: {
          ...PULL_REQUEST_RESOURCE_TYPE,
          namespace: current.metadata.namespace,
          name: current.metadata.name,
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
        ...REQUIREMENT_RESOURCE_TYPE,
        namespace: "pi_reqloop",
        name: "req_active",
        uid: "uid-req_active",
      },
    });
    expect(
      await controller.present?.(resources.current()!),
    ).toBeUndefined();
  });

  test("pins legacy Requirement associations to their current uid", async () => {
    const resources = resourceClient();
    resources.addRequirement();
    const pullRequest = await upsertPullRequest(resources.client, observation);
    const legacy = await resources.client.patchStatus(pullRequest, {
      requirementAssociation: {
        state: "linked",
        requirement: {
          ...REQUIREMENT_RESOURCE_TYPE,
          namespace: "pi_reqloop",
          name: "req_active",
        },
      },
    });

    await createPullRequestController(resources.client).reconcile(
      batonSnapshot(),
      legacy,
    );

    expect(
      resources.current()?.status.requirementAssociation,
    ).toMatchObject({
      state: "linked",
      requirement: {
        name: "req_active",
        uid: "uid-req_active",
      },
    });
  });

  test("stops polling closed and review-settled merged PullRequests", async () => {
    for (
      const status of [
        { lifecycle: "closed", reviewThreads: "unknown" },
        { lifecycle: "merged", reviewThreads: "resolved" },
      ] as const
    ) {
      const resources = resourceClient();
      const terminal = await upsertPullRequest(resources.client, {
        ...observation,
        ...status,
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
      ).reconcile(batonSnapshot(), terminal);

      expect(calls).toBe(0);
    }
  });

  test("keeps observing merged PullRequests until review state settles", async () => {
    const resources = resourceClient();
    const merged = await upsertPullRequest(resources.client, {
      ...observation,
      lifecycle: "merged",
      reviewThreads: "unknown",
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
        return {
          ...observation,
          lifecycle: "merged",
          reviewThreads: "resolved",
          observedAt: "2026-07-28T08:00:00.000Z",
        };
      },
    };

    await createPullRequestController(
      resources.client,
      [forge],
    ).reconcile(batonSnapshot(), merged);

    expect(calls).toBe(1);
    expect(resources.current()?.status).toMatchObject({
      lifecycle: "merged",
      reviewThreads: "resolved",
    });
  });

  test("does not immediately repoll a fresh open observation", async () => {
    const resources = resourceClient();
    const current = await upsertPullRequest(resources.client, {
      ...observation,
      observedAt: new Date().toISOString(),
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
    ).reconcile(batonSnapshot(), current);

    expect(calls).toBe(0);
  });

  test("records an ignored review decision and does not remind again", async () => {
    const resources = resourceClient();
    const pullRequest = await upsertPullRequest(
      resources.client,
      observation,
    );
    const reviewConnector: PullRequestReviewConnector = {
      async listLatest() {
        return [];
      },
      async latest() {
        return {
          identity: observation.identity,
          key: "review_ignored",
          status: "success",
          sha: "head",
          count: 1,
          failed: 0,
          findings: [{
            path: "src/app.ts",
            message: "review comment",
          }],
        };
      },
    };
    const controller = createPullRequestController(
      resources.client,
      [],
      reviewConnector,
    );
    const prompted = await controller.reconcile(
      batonSnapshot(),
      pullRequest,
    );
    if (prompted?.output?.kind !== "interaction") {
      throw new Error("expected review Interaction");
    }

    await controller.reconcile(
      batonSnapshot([{
        interactionId: "ix_ignore",
        decisionKey: prompted.output.decisionKey,
        resource: {
          ...PULL_REQUEST_RESOURCE_TYPE,
          namespace: pullRequest.metadata.namespace,
          name: pullRequest.metadata.name,
        },
        outcome: { kind: "answered", values: ["ignore"] },
      }]),
      resources.current()!,
    );

    expect(resources.current()?.status.reviewDecision).toEqual({
      reviewKey: "review_ignored",
      choice: "ignore",
    });
    expect(
      await controller.reconcile(
        batonSnapshot(),
        resources.current()!,
      ),
    ).toBeUndefined();
  });

  test("uses Forge listing as Repository discovery fallback", async () => {
    const resources = resourceClient();
    let listCalls = 0;
    const forge: ForgeConnector = {
      source: "github-primary",
      provider: "github",
      async list(repository) {
        listCalls += 1;
        return [{
          source: "github-primary",
          repository,
          number: 18,
        }];
      },
      async get(identity) {
        return {
          identity,
          lifecycle: "open",
          reviewThreads: "unknown",
          mergeability: "unknown",
          observedAt: "2026-07-26T11:00:00.000Z",
        };
      },
    };
    const controller = createRepositoryController(
      resources.client,
      [forge],
    );
    const repository = await resources.client.create<
      RepositorySpec,
      RepositoryStatus
    >(REPOSITORY_RESOURCE_TYPE, {
      name: "repo_test",
      spec: {
        identity: {
        source: "github-primary",
        repository: "compforge/reqloop",
        },
      },
    });
    resources.observeRepository(repository);
    const observedWorkspace = resources.workspaceCurrent()!;
    const repositoryWatch = controller.watches?.[0];
    expect(
      await repositoryWatch?.handler.create({ object: observedWorkspace }),
    ).toEqual([{ name: repository.metadata.name }]);

    const result = await controller.reconcile({} as never, repository);

    expect(resources.current()?.spec.identity).toEqual({
      source: "github-primary",
      repository: "compforge/reqloop",
      number: 18,
    });
    await createPullRequestController(
      resources.client,
      [forge],
    ).reconcile(
      batonSnapshot(),
      resources.current()!,
    );
    expect(resources.current()?.status).toEqual({
      lifecycle: "open",
      reviewThreads: "unknown",
      reviewActivityKey: null,
      mergeability: "unknown",
      observedAt: "2026-07-26T11:00:00.000Z",
    });
    const repositoryStatus = resources.repositoryCurrent()?.status;
    expect(repositoryStatus).toMatchObject({
      connectorAvailable: true,
      discoveredPullRequests: 1,
    });
    expect(typeof repositoryStatus?.lastScanAt).toBe("string");
    expect(result).toEqual({ requeueAfterMs: 30_000 });
    const replay = await controller.reconcile(
      {} as never,
      resources.repositoryCurrent()!,
    );
    expect(listCalls).toBe(1);
    expect(replay?.requeueAfterMs).toBeGreaterThan(0);
    expect(replay?.requeueAfterMs).toBeLessThanOrEqual(30_000);

    resources.clearWorkspace();
    expect(await repositoryWatch?.handler.update({
      oldObject: observedWorkspace,
      newObject: resources.workspaceCurrent()!,
    })).toEqual([{ name: repository.metadata.name }]);
    expect(
      await repositoryWatch?.handler.delete({ object: observedWorkspace }),
    ).toEqual([{ name: repository.metadata.name }]);
    await controller.reconcile(
      {} as never,
      resources.repositoryCurrent()!,
    );
    expect(resources.repositoryCurrent()?.status.inScope).toBe(false);
    expect(
      await controller.present?.(resources.repositoryCurrent()!),
    ).toBeUndefined();
    expect(listCalls).toBe(1);
  });
});
