import {
  describe,
  expect,
  test,
} from "bun:test";

import type {
  Resource,
  ResourceClient,
  ResourceRef,
  ResourceType,
  SourceContext,
} from "@compforge/baton-plugin";

import {
  CODE_REVIEW_RESOURCE_TYPE,
  codeReviewNeedsAttention,
  codeReviewResourceName,
  codeReviewSpec,
  type CodeReviewSpec,
  type CodeReviewStatus,
  type Comment,
  createCodeReviewController,
  type ForgeConnector,
  ForgeCodeReviewSource,
  latestCodeReviewObservation,
  PULL_REQUEST_RESOURCE_TYPE,
  type PullRequestSpec,
  type PullRequestStatus,
} from "../src/index.ts";
import { reconcileContext, TEST_NAMESPACE } from "./reconcile-context.ts";

const NOW = "2026-07-30T10:00:00.000Z";
const PULL_REQUEST = {
  source: "github.com",
  repository: "compforge/reqloop",
  number: 68,
} as const;

function reviewComments(): readonly Comment[] {
  return [
    {
      id: "finding-1",
      body: [
        "🤖 **devloop code-review**",
        "",
        "missing cancellation",
        "",
        "<sub>ccr:fp=fp1</sub>",
      ].join("\n"),
      replyable: true,
      replies: [],
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
      replyable: false,
      replies: [],
      createdAt: "2026-07-30T09:30:00.000Z",
    },
  ];
}

function repeatedReviewComments(): readonly Comment[] {
  return [
    ...reviewComments(),
    {
      id: "finding-2",
      body: [
        "🤖 **devloop code-review**",
        "",
        "missing timeout",
        "",
        "<sub>ccr:fp=fp2</sub>",
      ].join("\n"),
      replyable: true,
      replies: [],
      path: "src/worker.ts",
      line: 18,
      createdAt: "2026-07-30T09:39:00.000Z",
    },
    {
      id: "summary-2",
      body: [
        "🤖 **devloop code-review** · `origin/main..HEAD` · `abc123def`",
        "",
        "**1 finding(s)**（1 条已锚到 diff）",
      ].join("\n"),
      replyable: false,
      replies: [],
      createdAt: "2026-07-30T09:40:00.000Z",
    },
  ];
}

function labeledReviewComments(): readonly Comment[] {
  const [finding, ...comments] = reviewComments();
  return [
    {
      ...finding!,
      replies: [{
        id: "label-1",
        body: "ccr:label=important — confirmed against the current code",
        replyable: false,
        replies: [],
        createdAt: "2026-07-30T09:35:00.000Z",
      }],
    },
    ...comments,
  ];
}

function forge(comments: readonly Comment[]): ForgeConnector {
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
      namespace: TEST_NAMESPACE,
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

function codeReviewClient(
  resource: Readonly<Resource<CodeReviewSpec, CodeReviewStatus>>,
  pullRequests: readonly Readonly<
    Resource<PullRequestSpec, PullRequestStatus>
  >[] = [],
): {
  readonly client: ResourceClient;
  readonly current: () => Readonly<
    Resource<CodeReviewSpec, CodeReviewStatus>
  >;
  readonly deleted: readonly string[];
} {
  let current = resource;
  const deleted: string[] = [];
  return {
    client: {
      namespace: TEST_NAMESPACE,
      async get<TSpec, TStatus>(
        ref: ResourceRef,
      ): Promise<Readonly<Resource<TSpec, TStatus>> | undefined> {
        const candidate = ref.kind === CODE_REVIEW_RESOURCE_TYPE.kind
          ? current
          : pullRequests.find(({ metadata }) =>
            metadata.namespace === ref.namespace &&
            metadata.name === ref.name
          );
        if (
          !candidate ||
          candidate.apiVersion !== ref.apiVersion ||
          candidate.kind !== ref.kind ||
          candidate.metadata.namespace !== ref.namespace ||
          candidate.metadata.name !== ref.name ||
          (ref.uid !== undefined && candidate.metadata.uid !== ref.uid)
        ) {
          return undefined;
        }
        return candidate as unknown as Readonly<Resource<TSpec, TStatus>>;
      },
      async list(type: ResourceType) {
        if (type.kind === PULL_REQUEST_RESOURCE_TYPE.kind) {
          return pullRequests;
        }
        return type.kind === CODE_REVIEW_RESOURCE_TYPE.kind ? [current] : [];
      },
      async patchStatus(
        candidate: Readonly<Resource<CodeReviewSpec, CodeReviewStatus>>,
        patch: Partial<CodeReviewStatus>,
      ) {
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
      async delete(_type: ResourceType, name: string) {
        deleted.push(name);
      },
    } as unknown as ResourceClient,
    current: () => current,
    deleted,
  };
}

describe("CodeReview Resource", () => {
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
      }],
      reviewedRange: "origin/main..HEAD",
      publicationSummary: expect.stringContaining("1 finding(s)"),
      completedAt: "2026-07-30T09:30:00.000Z",
    });
    expect(codeReviewResourceName(
      codeReviewSpec(observation!),
    )).toMatch(/^code-review-/);
  });

  test("does not invent a CodeReview when Forge has no review comment", () => {
    expect(latestCodeReviewObservation(PULL_REQUEST, [])).toBeUndefined();
    expect(latestCodeReviewObservation(PULL_REQUEST, [{
      id: "ordinary",
      body: "Looks good",
      replyable: false,
      replies: [],
      createdAt: "2026-07-30T09:30:00.000Z",
    }])).toBeUndefined();
  });

  test("does not treat a standalone ccr fingerprint as a published finding", () => {
    const [finding, summary] = reviewComments();
    const observation = latestCodeReviewObservation(PULL_REQUEST, [
      { ...finding!, replyable: false },
      summary!,
    ]);

    expect(observation?.findings).toEqual([]);
  });

  test("joins the first valid ccr label reply onto its finding comment", () => {
    const observation = latestCodeReviewObservation(
      PULL_REQUEST,
      labeledReviewComments(),
    );

    expect(observation?.findings).toEqual([
      expect.objectContaining({
        label: "important",
      }),
    ]);
  });

  test("admits every recent run after merge, including a same-revision rerun", async () => {
    const emitted: Parameters<SourceContext<CodeReviewSpec>["emit"]>[0][] = [];
    const abort = new AbortController();
    const resources = {
      namespace: TEST_NAMESPACE,
      async list(type: { kind: string }) {
        return type.kind === PULL_REQUEST_RESOURCE_TYPE.kind
          ? [pullRequestResource()]
          : [];
      },
    } as unknown as ResourceClient;
    const source = new ForgeCodeReviewSource(
      resources,
      [forge(repeatedReviewComments())],
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

    expect(emitted).toEqual([
      {
        name: expect.stringMatching(/^code-review-/),
        spec: {
          pullRequest: PULL_REQUEST,
          runKey: "summary-1",
          revision: "abc123def",
        },
      },
      {
        name: expect.stringMatching(/^code-review-/),
        spec: {
          pullRequest: PULL_REQUEST,
          runKey: "summary-2",
          revision: "abc123def",
        },
      },
    ]);
    expect(emitted[0]?.name).not.toBe(emitted[1]?.name);
  });

  test("offers advisory follow-up once and expires independently", async () => {
    const observation = latestCodeReviewObservation(
      PULL_REQUEST,
      reviewComments(),
    )!;
    const spec = codeReviewSpec(observation);
    const resource: Readonly<Resource<CodeReviewSpec, CodeReviewStatus>> = {
      ...CODE_REVIEW_RESOURCE_TYPE,
      metadata: {
        name: codeReviewResourceName(spec),
        namespace: TEST_NAMESPACE,
        uid: "uid-code-review-1",
        generation: 1,
        resourceVersion: "1",
        creationTimestamp: NOW,
      },
      spec,
      status: {},
    };
    const resources = codeReviewClient(resource);
    const controller = createCodeReviewController(
      resources.client,
      [forge(reviewComments())],
      [],
      { now: () => new Date(NOW) },
    );

    const promptContext = reconcileContext({
      answer: { state: "success", value: "accept" },
    });
    await controller.reconcile(promptContext.context, resource);
    expect(resources.current().status).toMatchObject({
      phase: "completed",
      verdict: "action-required",
      result: {
        findingCount: 1,
        summaryCommentId: "summary-1",
      },
      expiresAt: "2026-07-31T09:30:00.000Z",
    });
    expect(promptContext.asks[0]).toMatchObject({
      title: "AI review comments found",
      timeoutMs: 10 * 60_000,
    });
    expect(resources.current().status.decision).toMatchObject({
      choice: "accept",
      followUpTurnId: "turn_test",
    });
    expect(promptContext.drafts[0]).toMatchObject({
      title: "Handle AI review comments",
      timeoutMs: 30 * 60_000,
      prompt: expect.stringContaining("label-review"),
    });
    const replayContext = reconcileContext();
    await controller.reconcile(replayContext.context, resources.current());
    expect(replayContext.asks).toEqual([]);
    expect(replayContext.drafts).toEqual([]);
    expect(resources.deleted).toEqual([]);
    expect(codeReviewNeedsAttention(resources.current().status)).toBe(true);
    expect(
      await controller.present?.(resources.current()),
    ).toMatchObject({
      status: "1 finding · 0/1 labeled",
    });

    const labeled = createCodeReviewController(
      resources.client,
      [forge(labeledReviewComments())],
      [],
      { now: () => new Date(NOW) },
    );
    await labeled.reconcile(reconcileContext().context, resources.current());
    expect(resources.current().status.result?.findings).toEqual([
      expect.objectContaining({ label: "important" }),
    ]);
    expect(codeReviewNeedsAttention(resources.current().status)).toBe(false);
    expect(
      await labeled.present?.(resources.current()),
    ).toBeUndefined();

    const expired = createCodeReviewController(
      resources.client,
      [forge(reviewComments())],
      [],
      { now: () => new Date("2026-07-31T10:00:00.000Z") },
    );
    await expired.reconcile(reconcileContext().context, resources.current());
    expect(resources.deleted).toEqual([resource.metadata.name]);
  });

  test("defers Board presentation to a bound PullRequest", async () => {
    const observation = latestCodeReviewObservation(
      PULL_REQUEST,
      reviewComments(),
    )!;
    const spec = codeReviewSpec(observation);
    const resource: Readonly<Resource<CodeReviewSpec, CodeReviewStatus>> = {
      ...CODE_REVIEW_RESOURCE_TYPE,
      metadata: {
        name: codeReviewResourceName(spec),
        namespace: TEST_NAMESPACE,
        uid: "uid-code-review-bound",
        generation: 1,
        resourceVersion: "1",
        creationTimestamp: NOW,
      },
      spec,
      status: {
        phase: "completed",
        verdict: "action-required",
        result: {
          findingCount: 1,
          failedFileCount: 0,
          findings: observation.findings,
          summaryCommentId: observation.key,
        },
        completedAt: observation.completedAt,
        expiresAt: "2026-07-31T09:30:00.000Z",
      },
    };
    const resources = codeReviewClient(resource, [pullRequestResource()]);
    const controller = createCodeReviewController(resources.client);

    expect(await controller.present?.(resource)).toBeUndefined();
  });
});
