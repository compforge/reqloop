import {
  describe,
  expect,
  test,
} from "bun:test";

import type {
  BatonSnapshot,
  Resource,
  ResourceClient,
  SourceContext,
} from "@compforge/baton-plugin";

import {
  codeReviewEvaluationSpec,
  createEvaluationController,
  EVALUATION_RESOURCE_TYPE,
  evaluationResourceName,
  type EvaluationSpec,
  type EvaluationStatus,
  type ForgeComment,
  type ForgeConnector,
  ForgeEvaluationSource,
  latestCodeReviewObservation,
  PULL_REQUEST_RESOURCE_TYPE,
  type PullRequestSpec,
  type PullRequestStatus,
} from "../src/index.ts";

const NOW = "2026-07-30T10:00:00.000Z";
const PULL_REQUEST = {
  source: "github.com",
  repository: "compforge/reqloop",
  number: 68,
} as const;

function reviewComments(): readonly ForgeComment[] {
  return [
    {
      id: "finding-1",
      threadId: "finding-1",
      body: [
        "🤖 **devloop code-review**",
        "",
        "missing cancellation",
        "",
        "<sub>ccr:fp=fp1</sub>",
      ].join("\n"),
      path: "src/app.ts",
      line: 42,
      createdAt: "2026-07-30T09:29:00.000Z",
    },
    {
      id: "summary-1",
      body: [
        "🤖 **devloop code-review** · `origin/main..HEAD` · `abc123def`",
        "",
        "**1 finding(s)**（1 条已锚到 diff）",
      ].join("\n"),
      createdAt: "2026-07-30T09:30:00.000Z",
    },
  ];
}

function forge(comments: readonly ForgeComment[]): ForgeConnector {
  return {
    source: PULL_REQUEST.source,
    provider: "github",
    async list() {
      return [];
    },
    async get() {
      throw new Error("not used");
    },
    async comments() {
      return comments;
    },
  };
}

function pullRequestResource(): Readonly<
  Resource<PullRequestSpec, PullRequestStatus>
> {
  return {
    ...PULL_REQUEST_RESOURCE_TYPE,
    metadata: {
      name: "pr_68",
      namespace: "reqloop_default",
      uid: "uid-pr-68",
      generation: 1,
      resourceVersion: "1",
      creationTimestamp: "2026-07-29T09:00:00.000Z",
    },
    spec: { identity: PULL_REQUEST },
    status: {
      lifecycle: "merged",
      observedAt: "2026-07-30T09:45:00.000Z",
    },
  };
}

function batonSnapshot(
  pluginInteractions: BatonSnapshot["pluginInteractions"] = [],
): BatonSnapshot {
  return {
    session: {
      batonSessionId: "bs_test",
      cwd: "/repo",
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

function evaluationClient(
  resource: Readonly<Resource<EvaluationSpec, EvaluationStatus>>,
): {
  readonly client: ResourceClient;
  readonly current: () => Readonly<
    Resource<EvaluationSpec, EvaluationStatus>
  >;
  readonly deleted: readonly string[];
} {
  let current = resource;
  const deleted: string[] = [];
  return {
    client: {
      async patchStatus(candidate, patch) {
        current = {
          ...candidate,
          metadata: {
            ...candidate.metadata,
            resourceVersion: String(
              Number(candidate.metadata.resourceVersion) + 1,
            ),
          },
          status: { ...candidate.status, ...patch },
        } as typeof current;
        return current;
      },
      async delete(_type, name) {
        deleted.push(name);
      },
    } as ResourceClient,
    current: () => current,
    deleted,
  };
}

describe("Evaluation Resource", () => {
  test("maps one devloop review summary and its Forge finding comments", () => {
    const observation = latestCodeReviewObservation(
      PULL_REQUEST,
      reviewComments(),
    );

    expect(observation).toEqual({
      pullRequest: PULL_REQUEST,
      key: "summary-1",
      sha: "abc123def",
      count: 1,
      failed: 0,
      findings: [{
        path: "src/app.ts",
        message: "missing cancellation",
        fingerprint: "fp1",
        commentId: "finding-1",
        threadId: "finding-1",
      }],
      reviewedRange: "origin/main..HEAD",
      publicationSummary: expect.stringContaining("1 finding(s)"),
      completedAt: "2026-07-30T09:30:00.000Z",
    });
    expect(evaluationResourceName(
      codeReviewEvaluationSpec(observation!),
    )).toMatch(/^evaluation-/);
  });

  test("does not invent an Evaluation when Forge has no review comment", () => {
    expect(latestCodeReviewObservation(PULL_REQUEST, [])).toBeUndefined();
    expect(latestCodeReviewObservation(PULL_REQUEST, [{
      id: "ordinary",
      body: "Looks good",
      createdAt: "2026-07-30T09:30:00.000Z",
    }])).toBeUndefined();
  });

  test("admits a recent Evaluation even after the PullRequest merged", async () => {
    const emitted: Parameters<SourceContext<EvaluationSpec>["emit"]>[0][] = [];
    const abort = new AbortController();
    const resources = {
      async list(type: { kind: string }) {
        return type.kind === PULL_REQUEST_RESOURCE_TYPE.kind
          ? [pullRequestResource()]
          : [];
      },
    } as unknown as ResourceClient;
    const source = new ForgeEvaluationSource(
      resources,
      [forge(reviewComments())],
      {
        now: () => new Date(NOW),
        resyncIntervalMs: 60_000,
      },
    );

    await source.start({
      signal: abort.signal,
      async emit(resource) {
        emitted.push(resource);
      },
      reportError(error) {
        throw error;
      },
    });
    abort.abort();

    expect(emitted).toEqual([{
      name: expect.stringMatching(/^evaluation-/),
      spec: {
        kind: "code-review",
        target: {
          kind: "pull-request",
          identity: PULL_REQUEST,
        },
        runKey: "summary-1",
        revision: "abc123def",
      },
    }]);
  });

  test("offers advisory follow-up once and expires independently", async () => {
    const observation = latestCodeReviewObservation(
      PULL_REQUEST,
      reviewComments(),
    )!;
    const spec = codeReviewEvaluationSpec(observation);
    const resource: Readonly<Resource<EvaluationSpec, EvaluationStatus>> = {
      ...EVALUATION_RESOURCE_TYPE,
      metadata: {
        name: evaluationResourceName(spec),
        namespace: "reqloop_default",
        uid: "uid-evaluation-1",
        generation: 1,
        resourceVersion: "1",
        creationTimestamp: NOW,
      },
      spec,
      status: {},
    };
    const resources = evaluationClient(resource);
    const controller = createEvaluationController(
      resources.client,
      [forge(reviewComments())],
      [],
      { now: () => new Date(NOW) },
    );

    const prompted = await controller.reconcile(
      batonSnapshot(),
      resource,
    );
    expect(resources.current().status).toMatchObject({
      phase: "completed",
      verdict: "action-required",
      result: {
        kind: "code-review",
        findingCount: 1,
        summaryCommentId: "summary-1",
      },
      expiresAt: "2026-07-31T09:30:00.000Z",
    });
    expect(prompted?.output).toMatchObject({
      kind: "interaction",
      title: "AI review comments found",
    });
    if (prompted?.output?.kind !== "interaction") {
      throw new Error("expected review Interaction");
    }

    const accepted = await controller.reconcile(
      batonSnapshot([{
        interactionId: "ix-review-accept",
        decisionKey: prompted.output.decisionKey,
        resource: {
          ...EVALUATION_RESOURCE_TYPE,
          namespace: resource.metadata.namespace,
          name: resource.metadata.name,
          uid: resource.metadata.uid,
        },
        outcome: { kind: "answered", values: ["accept"] },
      }]),
      resources.current(),
    );
    expect(resources.current().status.decision).toMatchObject({
      choice: "accept",
    });
    expect(accepted?.output).toMatchObject({
      kind: "proposed-input",
      text: expect.stringContaining(
        "src/app.ts — missing cancellation",
      ),
    });
    expect(resources.deleted).toEqual([]);
    expect(
      await controller.present?.(resources.current()),
    ).toBeUndefined();

    const expired = createEvaluationController(
      resources.client,
      [forge(reviewComments())],
      [],
      { now: () => new Date("2026-07-31T10:00:00.000Z") },
    );
    await expired.reconcile(batonSnapshot(), resources.current());
    expect(resources.deleted).toEqual([resource.metadata.name]);
  });
});
