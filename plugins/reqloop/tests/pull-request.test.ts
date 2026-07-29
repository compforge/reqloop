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
  REQUIREMENT_CONDITION,
  REQUIREMENT_RESOURCE_TYPE,
  type RequirementSpec,
  type RequirementStatus,
  updatePullRequestObservation,
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
  readonly addRequirement: (
    name?: string,
    status?: RequirementStatus,
  ) => void;
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
    addRequirement(
      name = "req_active",
      status: RequirementStatus = { externalState: "in_progress" },
    ) {
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
        status,
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
  title: "Keep Board focused",
  url: "https://github.com/compforge/reqloop/pull/17",
  lifecycle: "open",
  reviewThreads: "unresolved",
  mergeability: "ready",
  observedAt: "2026-07-26T08:00:00.000Z",
};

async function materializePullRequest(
  resources: ReturnType<typeof resourceClient>,
  observed: PullRequest,
): Promise<Readonly<Resource<PullRequestSpec, PullRequestStatus>>> {
  await resources.client.create<PullRequestSpec, PullRequestStatus>(
    PULL_REQUEST_RESOURCE_TYPE,
    {
      name: pullRequestResourceId(observed.identity),
      spec: { identity: observed.identity },
    },
  );
  return await updatePullRequestObservation(resources.client, observed);
}

describe("PullRequest Resource", () => {
  test("uses one stable Resource for repeated external observations", async () => {
    const resources = resourceClient();

    const created = await materializePullRequest(
      resources,
      observation,
    );
    const repeated = await updatePullRequestObservation(
      resources.client,
      observation,
    );

    expect({
      apiVersion: created.apiVersion,
      kind: created.kind,
    }).toEqual({
      apiVersion: PULL_REQUEST_RESOURCE_TYPE.apiVersion,
      kind: PULL_REQUEST_RESOURCE_TYPE.kind,
    });
    expect(created.metadata.name).toBe(
      pullRequestResourceId(observation.identity),
    );
    expect(created.spec).toEqual({ identity: observation.identity });
    expect(created.status).toEqual({
      title: "Keep Board focused",
      url: "https://github.com/compforge/reqloop/pull/17",
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

  test("shows only unlinked open PullRequests on the Board", async () => {
    const controller = createPullRequestController();
    const resources = resourceClient();
    const pullRequest = await materializePullRequest(
      resources,
      observation,
    );

    expect(controller.resourceType).toBe(PULL_REQUEST_RESOURCE_TYPE);
    const expectedPresentation = {
      title: "compforge/reqloop #17",
      url: "https://github.com/compforge/reqloop/pull/17",
      status: "Unresolved review threads",
      detail: "Keep Board focused",
      priority: 100,
      tone: "warning",
    } as const;
    expect(await controller.present?.(pullRequest)).toEqual(
      expectedPresentation,
    );
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
    const pullRequest = await materializePullRequest(
      resources,
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
          title: "Already merged",
          url: "https://github.com/compforge/reqloop/pull/17",
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
      title: "Already merged",
      url: "https://github.com/compforge/reqloop/pull/17",
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
    const pullRequest = await materializePullRequest(
      resources,
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

  test("does not offer a Requirement closed locally by the user", async () => {
    const resources = resourceClient();
    resources.addRequirement("req_closed", {
      externalState: "in_progress",
      conditions: [{
        type: REQUIREMENT_CONDITION.closureRequested,
        status: "True",
        observedGeneration: 1,
        lastTransitionTime: "2026-07-26T12:00:00.000Z",
        reason: "UserConfirmed",
        message: "The user asked reqloop to stop tracking this Requirement.",
      }],
    });
    const pullRequest = await materializePullRequest(
      resources,
      observation,
    );
    const controller = createPullRequestController(resources.client);
    const requirement = (await resources.client.list<
      RequirementSpec,
      RequirementStatus
    >(REQUIREMENT_RESOURCE_TYPE))[0]!;

    expect(
      await controller.watches?.[0]?.handler.create({ object: requirement }),
    ).toEqual([]);
    expect(
      await controller.reconcile(batonSnapshot(), pullRequest),
    ).toBeUndefined();
  });

  test("proposes Harness follow-up once for each merge-conflict episode", async () => {
    const resources = resourceClient();
    const conflicted = await materializePullRequest(resources, {
      ...observation,
      reviewThreads: "resolved",
      mergeability: "conflicted",
    });
    const controller = createPullRequestController(resources.client);

    const prompted = await controller.reconcile(
      batonSnapshot(),
      conflicted,
    );
    expect(prompted?.output).toMatchObject({
      kind: "interaction",
      title: "Merge conflict found",
      options: [
        {
          optionId: "accept",
          label: "Accept",
        },
        {
          optionId: "ignore",
          label: "Ignore",
          role: "reject",
        },
      ],
    });
    if (prompted?.output?.kind !== "interaction") {
      throw new Error("expected merge-conflict Interaction");
    }
    expect(resources.current()?.status.mergeConflictDecision).toEqual({
      decisionKey: prompted.output.decisionKey,
    });

    const accepted = await controller.reconcile(
      batonSnapshot([{
        interactionId: "ix_merge_conflict",
        decisionKey: prompted.output.decisionKey,
        resource: {
          ...PULL_REQUEST_RESOURCE_TYPE,
          namespace: conflicted.metadata.namespace,
          name: conflicted.metadata.name,
        },
        outcome: { kind: "answered", values: ["accept"] },
      }]),
      resources.current()!,
    );
    expect(resources.current()?.status.mergeConflictDecision).toEqual({
      decisionKey: prompted.output.decisionKey,
      choice: "accept",
    });
    expect(accepted?.output).toMatchObject({
      kind: "proposed-input",
      text: expect.stringContaining(
        "Resolve the merge conflicts for compforge/reqloop PR/MR 17",
      ),
    });
    expect(
      await controller.reconcile(batonSnapshot(), resources.current()!),
    ).toBeUndefined();

    const ready = await updatePullRequestObservation(resources.client, {
      ...observation,
      reviewThreads: "resolved",
      observedAt: "2026-07-26T09:00:00.000Z",
    });
    await controller.reconcile(batonSnapshot(), ready);
    expect(resources.current()?.status.mergeConflictDecision).toBeNull();

    const conflictedAgain = await updatePullRequestObservation(
      resources.client,
      {
        ...observation,
        reviewThreads: "resolved",
        mergeability: "conflicted",
        observedAt: "2026-07-26T10:00:00.000Z",
      },
    );
    const promptedAgain = await controller.reconcile(
      batonSnapshot(),
      conflictedAgain,
    );
    expect(promptedAgain?.output).toMatchObject({
      kind: "interaction",
      title: "Merge conflict found",
    });
    if (promptedAgain?.output?.kind !== "interaction") {
      throw new Error("expected a new merge-conflict Interaction");
    }
    expect(promptedAgain.output.decisionKey).not.toBe(
      prompted.output.decisionKey,
    );
  });

  test("pins legacy Requirement associations to their current uid", async () => {
    const resources = resourceClient();
    resources.addRequirement();
    const pullRequest = await materializePullRequest(resources, observation);
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
      const terminal = await materializePullRequest(resources, {
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
    const merged = await materializePullRequest(resources, {
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

  test("continues an actionable review after the PullRequest is merged", async () => {
    const resources = resourceClient();
    const merged = await materializePullRequest(resources, {
      ...observation,
      lifecycle: "merged",
    });
    const reviewConnector: PullRequestReviewConnector = {
      async listLatest() {
        return [];
      },
      async latest() {
        return {
          identity: observation.identity,
          key: "review_after_merge",
          status: "success",
          sha: "merged-head",
          count: 1,
          failed: 0,
          findings: [{
            path: "src/app.ts",
            message: "review comment after merge",
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
      merged,
    );
    if (prompted?.output?.kind !== "interaction") {
      throw new Error("expected review Interaction");
    }

    const accepted = await controller.reconcile(
      batonSnapshot([{
        interactionId: "ix_accept_after_merge",
        decisionKey: prompted.output.decisionKey,
        resource: {
          ...PULL_REQUEST_RESOURCE_TYPE,
          namespace: merged.metadata.namespace,
          name: merged.metadata.name,
        },
        outcome: { kind: "answered", values: ["accept"] },
      }]),
      resources.current()!,
    );

    expect(resources.current()?.status.reviewDecision).toEqual({
      reviewKey: "review_after_merge",
      choice: "accept",
    });
    expect(accepted?.output).toMatchObject({
      kind: "proposed-input",
      text: expect.stringContaining("review comment after merge"),
    });
  });

  test("does not immediately repoll a fresh open observation", async () => {
    const resources = resourceClient();
    const current = await materializePullRequest(resources, {
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

  test("polls an idle PullRequest at the lower observation cadence", async () => {
    const resources = resourceClient();
    const current = await materializePullRequest(resources, observation);
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
      undefined,
      [],
      async () => false,
    ).reconcile(batonSnapshot(), current);

    expect(calls).toBe(1);
  });

  test("does not poll an idle PullRequest before its lower cadence is due", async () => {
    const resources = resourceClient();
    const current = await materializePullRequest(resources, {
      ...observation,
      observedAt: new Date(Date.now() - 60_000).toISOString(),
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
      undefined,
      [],
      async () => false,
    ).reconcile(batonSnapshot(), current);

    expect(calls).toBe(0);
  });

  test("records an ignored review decision and does not remind again", async () => {
    const resources = resourceClient();
    const pullRequest = await materializePullRequest(
      resources,
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

  test("Repository reconciliation never expands the PullRequest set", async () => {
    const resources = resourceClient();
    let listCalls = 0;
    const forge: ForgeConnector = {
      source: "github-primary",
      provider: "github",
      async list() {
        listCalls += 1;
        return [];
      },
      async get(identity) {
        return {
          identity,
          title: "Needs observation",
          url: "https://github.com/compforge/reqloop/pull/17",
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
    await resources.client.create<PullRequestSpec, PullRequestStatus>(
      PULL_REQUEST_RESOURCE_TYPE,
      {
        name: pullRequestResourceId({
          source: "github-primary",
          repository: "compforge/reqloop",
          number: 18,
        }),
        spec: {
          identity: {
            source: "github-primary",
            repository: "compforge/reqloop",
            number: 18,
          },
        },
      },
    );
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
      title: "Needs observation",
      url: "https://github.com/compforge/reqloop/pull/17",
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
    expect(
      await controller.present?.(resources.repositoryCurrent()!),
    ).toBeUndefined();
    expect(result).toBeUndefined();
    const replay = await controller.reconcile(
      {} as never,
      resources.repositoryCurrent()!,
    );
    expect(listCalls).toBe(0);
    expect(replay).toBeUndefined();

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
    expect(listCalls).toBe(0);
  });
});
