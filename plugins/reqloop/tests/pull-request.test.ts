import {
  describe,
  expect,
  test,
} from "bun:test";

import type {
  Resource,
  ResourceClient,
  ResourceRef,
} from "@compforge/baton-plugin";

import {
  CODE_REVIEW_RESOURCE_TYPE,
  type CodeReviewSpec,
  type CodeReviewStatus,
  createRepositoryController,
  createPullRequestController,
  REPOSITORY_RESOURCE_TYPE,
  type ForgeConnector,
  type RepositorySpec,
  type RepositoryStatus,
  PULL_REQUEST_RESOURCE_TYPE,
  pullRequestResourceId,
  type PullRequest,
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
import { reconcileContext } from "./reconcile-context.ts";

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
  readonly addCodeReview: (
    status: CodeReviewStatus,
  ) => Readonly<Resource<CodeReviewSpec, CodeReviewStatus>>;
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
  let codeReview:
    | Readonly<Resource<CodeReviewSpec, CodeReviewStatus>>
    | undefined;
  const client = {
    get(ref: ResourceRef) {
      const candidate = [
        resource,
        requirement,
        repository,
        workspace,
        codeReview,
      ].find((item) =>
        item?.apiVersion === ref.apiVersion &&
        item.kind === ref.kind &&
        item.metadata.namespace === ref.namespace &&
        item.metadata.name === ref.name
      );
      if (
        !candidate ||
        (ref.uid !== undefined && candidate.metadata.uid !== ref.uid)
      ) {
        return undefined;
      }
      return candidate;
    },
    list(type: { apiVersion: string; kind: string }) {
      if (type.kind === CODE_REVIEW_RESOURCE_TYPE.kind) {
        return codeReview ? [codeReview] : [];
      }
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
    addCodeReview(status) {
      codeReview = {
        ...CODE_REVIEW_RESOURCE_TYPE,
        metadata: {
          name: "code-review-test",
          namespace: "pi_reqloop",
          uid: "uid-code-review-test",
          generation: 1,
          resourceVersion: "1",
          creationTimestamp: "2026-07-30T09:30:00.000Z",
        },
        spec: {
          pullRequest: observation.identity,
          runKey: "summary-1",
          revision: "abc123def",
        },
        status,
      };
      return codeReview;
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
      priority: expect.any(Number),
      tone: "warning",
    } as const;
    const presentation = await controller.present?.(pullRequest);
    expect(presentation).toEqual(expectedPresentation);
    expect(presentation?.priority).toBeGreaterThan(100);
    expect(presentation?.priority).toBeLessThan(101);
    const newerPresentation = await controller.present?.({
      ...pullRequest,
      metadata: {
        ...pullRequest.metadata,
        creationTimestamp: "2026-07-27T00:00:00.000Z",
      },
    });
    expect(newerPresentation?.priority).toBeGreaterThan(
      presentation?.priority ?? Number.POSITIVE_INFINITY,
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

  test("projects pending CodeReviews through a low-priority merged PR card", async () => {
    const resources = resourceClient();
    const pullRequest = await materializePullRequest(resources, {
      ...observation,
      lifecycle: "merged",
      reviewThreads: "resolved",
    });
    const codeReview = resources.addCodeReview({
      phase: "completed",
      verdict: "action-required",
      result: {
        findingCount: 1,
        failedFileCount: 0,
        findings: [{
          path: "src/app.ts",
          message: "missing cancellation",
          fingerprint: "fp1",
          commentId: "finding-1",
        }],
        summaryCommentId: "summary-1",
      },
      completedAt: "2026-07-30T09:30:00.000Z",
      expiresAt: "2026-07-31T09:30:00.000Z",
    });
    const controller = createPullRequestController(resources.client);

    const presentation = await controller.present?.(pullRequest);
    expect(presentation).toMatchObject({
      status: "Merged · AI review · 0/1 labeled",
      tone: "warning",
    });
    const conflicted = await controller.present?.({
      ...pullRequest,
      status: {
        ...pullRequest.status,
        lifecycle: "open",
        mergeability: "conflicted",
      },
    });
    expect(presentation?.priority).toBeLessThan(
      conflicted?.priority ?? Number.NEGATIVE_INFINITY,
    );

    const watch = controller.watches?.find(({ resourceType }) =>
      resourceType.kind === CODE_REVIEW_RESOURCE_TYPE.kind
    );
    expect(await watch?.handler.update?.({
      oldObject: codeReview,
      newObject: codeReview,
    })).toEqual([{ name: pullRequest.metadata.name }]);

    resources.addCodeReview({
      ...codeReview.status,
      result: {
        ...codeReview.status.result!,
        findings: [{
          ...codeReview.status.result!.findings[0]!,
          label: "important",
        }],
      },
    });
    expect(await controller.present?.(pullRequest)).toBeUndefined();
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

    const promptContext = reconcileContext({
      answer: {
        state: "success",
        value: "requirement:req_active",
      },
    });
    await controller.reconcile(promptContext.context, pullRequest);
    expect(promptContext.asks[0]).toMatchObject({
      title: "Associate pull request",
      timeoutMs: 10 * 60_000,
      choices: [
        {
          value: "requirement:req_active",
          label: "Requirement intake",
        },
        {
          value: "standalone",
          label: "Keep standalone",
        },
      ],
    });
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

  test("does not repeat a timed-out Requirement association", async () => {
    const resources = resourceClient();
    resources.addRequirement();
    const pullRequest = await materializePullRequest(resources, observation);
    const controller = createPullRequestController(resources.client);

    const timedOutContext = reconcileContext({
      answer: { state: "timeout" },
    });
    await controller.reconcile(timedOutContext.context, pullRequest);
    expect(timedOutContext.asks).toHaveLength(1);
    expect(resources.current()?.status.requirementAssociation).toEqual({
      state: "prompted",
    });

    const replayContext = reconcileContext();
    await controller.reconcile(replayContext.context, resources.current()!);
    expect(replayContext.asks).toEqual([]);
  });

  test("surfaces a failed Requirement association for retry", async () => {
    const resources = resourceClient();
    resources.addRequirement();
    const pullRequest = await materializePullRequest(resources, observation);
    const controller = createPullRequestController(resources.client);

    await expect(controller.reconcile(
      reconcileContext({
        answer: { state: "failure", error: "runner stopped" },
      }).context,
      pullRequest,
    )).rejects.toThrow(
      "Requirement association interaction failed: runner stopped",
    );
    expect(resources.current()?.status.requirementAssociation).toBeUndefined();
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
      await controller.reconcile(reconcileContext().context, pullRequest),
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

    const promptContext = reconcileContext({
      answer: { state: "success", value: "accept" },
    });
    await controller.reconcile(promptContext.context, conflicted);
    expect(promptContext.asks[0]).toMatchObject({
      title: "Merge conflict found",
      timeoutMs: 10 * 60_000,
      choices: [
        {
          value: "accept",
          label: "Accept",
        },
        {
          value: "ignore",
          label: "Ignore",
        },
      ],
    });
    expect(resources.current()?.status.mergeConflictDecision).toEqual({
      choice: "accept",
      followUpTurnId: "turn_test",
    });
    expect(promptContext.drafts[0]).toMatchObject({
      title: "Resolve merge conflicts",
      timeoutMs: 30 * 60_000,
      prompt: expect.stringContaining(
        "Resolve the merge conflicts for compforge/reqloop PR/MR 17",
      ),
    });
    const replayContext = reconcileContext();
    await controller.reconcile(replayContext.context, resources.current()!);
    expect(replayContext.asks).toEqual([]);
    expect(replayContext.drafts).toEqual([]);

    const ready = await updatePullRequestObservation(resources.client, {
      ...observation,
      reviewThreads: "resolved",
      observedAt: "2026-07-26T09:00:00.000Z",
    });
    await controller.reconcile(reconcileContext().context, ready);
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
    const nextContext = reconcileContext({
      answer: { state: "success", value: "accept" },
      draftResult: { state: "dismissed" },
    });
    await controller.reconcile(nextContext.context, conflictedAgain);
    expect(nextContext.asks[0]).toMatchObject({
      title: "Merge conflict found",
    });
    expect(nextContext.drafts).toHaveLength(1);
    expect(resources.current()?.status.mergeConflictDecision).toEqual({
      choice: "ignore",
    });
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
      reconcileContext().context,
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
      ).reconcile(reconcileContext().context, terminal);

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
    ).reconcile(reconcileContext().context, merged);

    expect(calls).toBe(1);
    expect(resources.current()?.status).toMatchObject({
      lifecycle: "merged",
      reviewThreads: "resolved",
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
    ).reconcile(reconcileContext().context, current);

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
      [],
      async () => false,
    ).reconcile(reconcileContext().context, current);

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
      [],
      async () => false,
    ).reconcile(reconcileContext().context, current);

    expect(calls).toBe(0);
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
      reconcileContext().context,
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
