import {
  afterEach,
  describe,
  expect,
  test,
} from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type {
  BatonSnapshot,
  Command,
  ContextProvider,
  Controller,
  PluginActivationContext,
  Resource,
  Source,
  SourceContext,
} from "@compforge/baton-plugin";

import reqloop, {
  createReqloopPackage,
  DevloopPullRequestSource,
  DevloopRepositorySource,
  DevloopReviewConnector,
  type ForgeConnector,
  ForgePullRequestSource,
  ForgeRepositorySource,
  REPOSITORY_RESOURCE_TYPE,
  loadMeegoRequirementConfigs,
  MeegleCliRequirementConnector,
  PULL_REQUEST_RESOURCE_TYPE,
  pullRequestResourceId,
  type PullRequestSpec,
  type PullRequestStatus,
  type RepositorySpec,
  type RequirementConnector,
  REQUIREMENT_RESOURCE_TYPE,
  type WorkspaceSpec,
  WorkspaceSource,
  WORKSPACE_RESOURCE_TYPE,
} from "../src/index.ts";

const roots: string[] = [];

function testRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "reqloop-review-"));
  roots.push(root);
  return root;
}

function historyPath(root: string): string {
  return join(root, ".devloop", "review-history.jsonl");
}

function appendReview(
  path: string,
  record: Record<string, unknown>,
): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`);
}

function initializeRepository(root: string): void {
  for (const args of [
    ["init"],
    ["remote", "add", "origin", "git@github.com:compforge/reqloop.git"],
  ]) {
    const result = Bun.spawnSync(["git", ...args], {
      cwd: root,
      stdout: "ignore",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.toString());
    }
  }
}

function commitRepository(root: string): string {
  const commit = Bun.spawnSync([
    "git",
    "-c",
    "user.name=ReqLoop Test",
    "-c",
    "user.email=reqloop@example.com",
    "commit",
    "--allow-empty",
    "-m",
    "initial",
  ], {
    cwd: root,
    stdout: "ignore",
    stderr: "pipe",
  });
  if (commit.exitCode !== 0) throw new Error(commit.stderr.toString());
  const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (head.exitCode !== 0) throw new Error(head.stderr.toString());
  return head.stdout.toString().trim();
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for source observation");
    }
    await Bun.sleep(10);
  }
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

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("ReqLoop PluginPackage", () => {
  test("keeps its Package identity aligned with manifest metadata", () => {
    const manifest = JSON.parse(
      readFileSync(
        new URL("../.baton-plugin/plugin.json", import.meta.url),
        "utf8",
      ),
    ) as { pluginId: string; version: string; entry: string };
    const packageJson = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };

    expect(reqloop.pluginId).toBe(manifest.pluginId);
    expect(reqloop.version).toBe(manifest.version);
    expect(packageJson.version).toBe(manifest.version);
    expect(manifest.entry).toBe("./src/index.ts");
  });

  test("reads only the current checkout's latest terminal review", async () => {
    const root = testRoot();
    const path = historyPath(root);
    appendReview(path, {
      ts: 1,
      status: "success",
      sha: "current-head",
      count: 1,
      failed: 0,
      pull_request: {
        source: "github.com",
        repository: "owner/repo",
        number: 7,
      },
      findings: [{ path: "src/app.ts", msg: "missing cancellation" }],
    });
    appendReview(path, {
      ts: 2,
      status: "success",
      sha: "another-worktree",
      branch: "feature",
      count: 2,
      failed: 0,
      pull_request: {
        source: "github.com",
        repository: "owner/repo",
        number: 8,
      },
    });
    appendReview(path, {
      ts: 3,
      status: "success",
      sha: "current-head",
      count: 9,
      failed: 0,
    });
    const connector = new DevloopReviewConnector(root, {
      historyPath: path,
      checkout: () => ({ headSha: "current-head", branch: "feature" }),
    });

    expect((await connector.listLatest())[0]).toMatchObject({
      identity: {
        source: "github.com",
        repository: "owner/repo",
        number: 7,
      },
      sha: "current-head",
      count: 1,
      findings: [
        {
          path: "src/app.ts",
          message: "missing cancellation",
        },
      ],
    });
  });

  test("reads review observations from every Workspace checkout", async () => {
    const root = testRoot();
    const first = join(root, "repo-a");
    const second = join(root, "repo-b");
    mkdirSync(first);
    mkdirSync(second);
    initializeRepository(first);
    initializeRepository(second);
    const firstHead = commitRepository(first);
    const secondHead = commitRepository(second);
    appendReview(historyPath(first), {
      status: "success",
      sha: firstHead,
      count: 1,
      failed: 0,
      pull_request: {
        source: "github.com",
        repository: "owner/repo-a",
        number: 7,
      },
    });
    appendReview(historyPath(second), {
      status: "success",
      sha: secondHead,
      count: 2,
      failed: 0,
      pull_request: {
        source: "github.com",
        repository: "owner/repo-b",
        number: 8,
      },
    });
    const connector = new DevloopReviewConnector(root, {
      workspaceCheckouts: () => [
        {
          path: first,
          source: "github.com",
          repository: "owner/repo-a",
        },
        {
          path: second,
          source: "github.com",
          repository: "owner/repo-b",
        },
      ],
    });

    expect(
      (await connector.listLatest()).map(
        ({ identity }) => identity.repository,
      ),
    ).toEqual(["owner/repo-a", "owner/repo-b"]);
    expect((await connector.latest({
      source: "github.com",
      repository: "owner/repo-b",
      number: 8,
    }))?.count).toBe(2);
  });

  test("contributes the current checkout as a Repository", async () => {
    const root = testRoot();
    initializeRepository(root);
    const emitted: Parameters<SourceContext<RepositorySpec>["emit"]>[0][] = [];
    const source = new DevloopRepositorySource(root);

    await source.start({
      signal: new AbortController().signal,
      async emit(resource) {
        emitted.push(resource);
      },
      reportError() {},
    });

    expect(emitted).toEqual([{
      name: expect.stringMatching(/^repo-/),
      spec: {
        identity: {
          source: "github.com",
          repository: "compforge/reqloop",
        },
      },
    }]);
  });

  test("Forge Sources own bounded Resource admission", async () => {
    const root = testRoot();
    initializeRepository(root);
    const repositoryEmits: Parameters<
      SourceContext<RepositorySpec>["emit"]
    >[0][] = [];
    const repositoryAbort = new AbortController();
    const repositorySource = new ForgeRepositorySource(root, {
      resyncIntervalMs: 60_000,
    });
    await repositorySource.start({
      signal: repositoryAbort.signal,
      async emit(resource) {
        repositoryEmits.push(resource);
      },
      reportError() {},
    });
    repositoryAbort.abort();

    const calls: unknown[] = [];
    const forge: ForgeConnector = {
      source: "github.com",
      provider: "github",
      async list(repository, query) {
        calls.push({ repository, query });
        return [30, 29].map((number) => ({
          source: "github.com",
          repository,
          number,
        }));
      },
      async get() {
        throw new Error("not used");
      },
    };
    const pullRequestEmits: Parameters<
      SourceContext<PullRequestSpec>["emit"]
    >[0][] = [];
    const pullRequestAbort = new AbortController();
    const pullRequestSource = new ForgePullRequestSource(root, [forge], {
      maxPerRepository: 2,
      maxResources: 1,
      resyncIntervalMs: 60_000,
    });
    await pullRequestSource.start({
      signal: pullRequestAbort.signal,
      async emit(resource) {
        pullRequestEmits.push(resource);
      },
      reportError() {},
    });
    pullRequestAbort.abort();

    expect(repositoryEmits).toEqual([{
      name: expect.stringMatching(/^repo-/),
      spec: {
        identity: {
          source: "github.com",
          repository: "compforge/reqloop",
        },
      },
    }]);
    expect(calls).toEqual([{
      repository: "compforge/reqloop",
      query: { state: "open", limit: 2 },
    }]);
    expect(pullRequestEmits).toEqual([{
      name: expect.stringMatching(/^pr_/),
      spec: {
        identity: {
          source: "github.com",
          repository: "compforge/reqloop",
          number: 30,
        },
      },
    }]);
  });

  test("contributes open PullRequests and watches devloop state", async () => {
    const root = testRoot();
    initializeRepository(root);
    const path = join(root, ".devloop", "pr.json");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{");
    const emitted: Parameters<
      SourceContext<PullRequestSpec>["emit"]
    >[0][] = [];
    const errors: unknown[] = [];
    const abort = new AbortController();
    const source = new DevloopPullRequestSource(root, {
      path,
      watchIntervalMs: 10,
    });

    await source.start({
      signal: abort.signal,
      async emit(resource) {
        emitted.push(resource);
      },
      reportError(error) {
        errors.push(error);
      },
    });

    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toContain("Could not parse devloop PR state");
    writeFileSync(path, JSON.stringify({
      prs: [
        { number: 30, state: "open" },
        { number: 29, state: "merged" },
        { number: 30, state: "open" },
        { number: 0, state: "open" },
      ],
    }));

    await waitFor(() => emitted.length === 1);
    abort.abort();
    expect(emitted).toEqual([{
      name: expect.stringMatching(/^pr_/),
      spec: {
        identity: {
          source: "github.com",
          repository: "compforge/reqloop",
          number: 30,
        },
      },
    }]);
  });

  test("Devloop Source admits review observations without creating in the Connector", async () => {
    const root = testRoot();
    initializeRepository(root);
    const emitted: Parameters<
      SourceContext<PullRequestSpec>["emit"]
    >[0][] = [];
    const source = new DevloopPullRequestSource(root, {
      reviewObservations: async () => [{
        identity: {
          source: "github.com",
          repository: "compforge/reqloop",
          number: 31,
        },
        key: "review-31",
        status: "success",
        sha: "head",
        count: 1,
        failed: 0,
        findings: [],
      }],
    });

    await source.start({
      signal: new AbortController().signal,
      async emit(resource) {
        emitted.push(resource);
      },
      reportError() {},
    });

    expect(emitted).toEqual([{
      name: expect.stringMatching(/^pr_/),
      spec: {
        identity: {
          source: "github.com",
          repository: "compforge/reqloop",
          number: 31,
        },
      },
    }]);
  });

  test("lists provider-neutral requirements and reads the selected requirement", async () => {
    const root = testRoot();
    const calls: string[] = [];
    const requirementConnector: RequirementConnector = {
      source: "meego",
      provider: "meego",
      async list(query) {
        calls.push(`list:${query?.text ?? ""}:${query?.limit ?? ""}`);
        if (query?.text === "missing") return [];
        return [
          {
            source: "meego",
            id: "REQ-7",
            category: "story",
            title: "Add requirement intake",
            state: "in_progress",
          },
        ];
      },
      async get(identity) {
        calls.push(
          `get:${identity.source}:${identity.category}:${identity.id}`,
        );
        return {
          ...identity,
          title: "Add requirement intake",
          state: "in_progress",
          description: "Expose a provider-neutral requirement command.",
          acceptanceCriteria: ["List requirements", "Read one requirement"],
        };
      },
    };
    let command: Command | undefined;
    let contextProvider: ContextProvider | undefined;
    const resourceTypes: { apiVersion: string; kind: string }[] = [];
    let workspaceController: Controller<unknown, unknown> | undefined;
    const context = {
      session: { batonSessionId: "bs_test", cwd: root },
      registerCommand(contribution: Command) {
        command = contribution;
      },
      registerContextProvider(provider: ContextProvider) {
        contextProvider = provider;
      },
      registerController(
        controller: Controller<unknown, unknown>,
      ) {
        resourceTypes.push(controller.resourceType);
        if (controller.resourceType.kind === WORKSPACE_RESOURCE_TYPE.kind) {
          workspaceController = controller;
        }
      },
    } as unknown as PluginActivationContext;

    await createReqloopPackage({ requirementConnector }).activate(context);
    expect(command).toMatchObject({
      commandId: "requirements",
      name: "requirements",
    });
    expect(resourceTypes).toEqual([
      REQUIREMENT_RESOURCE_TYPE,
      PULL_REQUEST_RESOURCE_TYPE,
      REPOSITORY_RESOURCE_TYPE,
      WORKSPACE_RESOURCE_TYPE,
    ]);
    expect(workspaceController?.sources?.[0]).toBeInstanceOf(
      WorkspaceSource,
    );
    expect(contextProvider?.kind).toBe("requirement");
    expect(await command!.execute({ argument: "intake" })).toMatchObject({
      kind: "picker",
      title: "Requirements · meego",
      search: {
        mode: "remote",
        query: "intake",
        placeholder: "Search requirements",
      },
      options: [
        {
          name: "Add requirement intake",
          description: "meego · story · REQ-7 · in_progress",
          value: '["meego","story","REQ-7"]',
        },
      ],
    });
    const recoverySearch = {
      argument: "intake",
      searchQuery: "recovery",
    };
    expect(await command!.execute(recoverySearch)).toMatchObject({
      kind: "picker",
      search: {
        mode: "remote",
        query: "recovery",
      },
    });
    const missingSearch = {
      argument: "intake",
      searchQuery: "missing",
    };
    expect(await command!.execute(missingSearch)).toMatchObject({
      kind: "picker",
      search: {
        mode: "remote",
        query: "missing",
      },
      options: [],
    });
    expect(
      await command!.execute({
        argument: "intake",
        selectedValue: '["meego","story","REQ-7"]',
      }),
    ).toMatchObject({
      kind: "message",
      text: expect.stringContaining("Acceptance criteria:\n- List requirements"),
    });
    expect(calls).toEqual([
      "list:intake:50",
      "list:recovery:50",
      "list:missing:50",
      "get:meego:story:REQ-7",
    ]);
  });

  test("loads multiple Meego requirement sources from standalone config", () => {
    const path = join(testRoot(), "reqloop.json");
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        requirements: {
          primary: {
            provider: "meego",
            projectKey: "primary-project",
          },
          secondary: {
            provider: "meego",
            projectKey: "secondary-project",
            profile: "secondary-profile",
            categories: ["story"],
          },
        },
      }),
    );

    expect(loadMeegoRequirementConfigs(path)).toEqual([
      {
        source: "primary",
        provider: "meego",
        projectKey: "primary-project",
        categories: ["story", "issue"],
      },
      {
        source: "secondary",
        provider: "meego",
        projectKey: "secondary-project",
        profile: "secondary-profile",
        categories: ["story"],
      },
    ]);
  });

  test("maps Meegle CLI query and detail output to requirements", async () => {
    const calls: string[][] = [];
    const connector = new MeegleCliRequirementConnector(
      {
        source: "llmops",
        provider: "meego",
        projectKey: "llmops",
        profile: "work",
        categories: ["story", "issue"],
      },
      async (args) => {
        calls.push([...args]);
        const category = args.join(" ").includes("`issue`")
          ? "issue"
          : "story";
        if (args[1] === "query") {
          return {
            data: {
              "1": [{
                moql_field_list: [
                  {
                    key: "work_item_id",
                    value: {
                      long_value: category === "story" ? 1001 : 2002,
                    },
                  },
                  {
                    key: "name",
                    value: {
                      string_value: category === "story"
                        ? "Requirement intake"
                        : "Fix requirement picker",
                    },
                  },
                  {
                    key: "work_item_status",
                    value: {
                      key_label_value_list: [{
                        key: category === "story" ? "doing" : "open",
                        label: category === "story" ? "开发中" : "待处理",
                      }],
                    },
                  },
                  {
                    key: "current_status_operator",
                    value: {
                      user_value_list: [{ name_cn: "Owner" }],
                    },
                  },
                  {
                    key: "updated_at",
                    value: {
                      string_value: category === "story"
                        ? "2026-01-01 10:00:00"
                        : "2026-01-02 10:00:00",
                    },
                  },
                ],
              }],
            },
          };
        }
        return {
          work_item_attribute: {
            work_item_id: "1001",
            work_item_name: "Requirement intake",
            work_item_status: { key: "doing", name: "开发中" },
            update_time: "2026-01-01T10:00:00+08:00",
            role_members: [{
              key: "operator",
              members: [{ name: "Owner" }],
            }],
          },
          work_item_fields: [
            {
              key: "description",
              value: "Normalize requirement platforms.",
            },
            {
              key: "acceptance_criteria",
              value: "- List requirements\n- Read details",
            },
          ],
        };
      },
    );

    expect(await connector.list({ text: "requirement", limit: 10 })).toEqual([
      {
        source: "llmops",
        category: "issue",
        id: "2002",
        title: "Fix requirement picker",
        state: "open",
        assignee: "Owner",
        updatedAt: "2026-01-02 10:00:00",
      },
      {
        source: "llmops",
        category: "story",
        id: "1001",
        title: "Requirement intake",
        state: "in_progress",
        assignee: "Owner",
        updatedAt: "2026-01-01 10:00:00",
      },
    ]);
    expect(
      await connector.get({
        source: "llmops",
        category: "story",
        id: "1001",
      }),
    ).toEqual({
      source: "llmops",
      category: "story",
      id: "1001",
      title: "Requirement intake",
      state: "in_progress",
      assignee: "Owner",
      updatedAt: "2026-01-01T10:00:00+08:00",
      description: "Normalize requirement platforms.",
      acceptanceCriteria: ["List requirements", "Read details"],
    });
    expect(calls).toHaveLength(3);
    expect(calls[0]).toContain("--profile");
    expect(calls[2]).toContain('["description"]');
  });

  test("aggregates active requirement sources and routes detail reads", async () => {
    const calls: string[] = [];
    const connector = (
      source: string,
      category: string,
      id: string,
    ): RequirementConnector => ({
      source,
      provider: "test",
      async list() {
        calls.push(`list:${source}`);
        return [{
          source,
          category,
          id,
          title: `${source} requirement`,
          state: "open",
        }];
      },
      async get(identity) {
        calls.push(`get:${source}:${identity.id}`);
        return {
          ...identity,
          title: `${source} requirement`,
          state: "open",
        };
      },
    });
    let command: Command | undefined;
    const context = {
      session: { batonSessionId: "bs_test", cwd: testRoot() },
      registerCommand(contribution: Command) {
        command = contribution;
      },
      registerContextProvider() {},
      registerController() {},
    } as unknown as PluginActivationContext;

    await createReqloopPackage({
      requirementConnectors: [
        connector("primary", "story", "REQ-1"),
        connector("secondary", "issue", "BUG-2"),
      ],
    }).activate(context);

    expect(await command!.execute({ argument: "" })).toMatchObject({
      kind: "picker",
      title: "Requirements · 2 sources",
      search: {
        mode: "remote",
        query: "",
        placeholder: "Search requirements",
      },
      options: [
        { value: '["primary","story","REQ-1"]' },
        { value: '["secondary","issue","BUG-2"]' },
      ],
    });
    await command!.execute({
      argument: "",
      selectedValue: '["secondary","issue","BUG-2"]',
    });
    expect(calls).toEqual([
      "list:primary",
      "list:secondary",
      "get:secondary:BUG-2",
    ]);
  });

  test("registers Sources and Watches on their Resource owners", async () => {
    const workspaceSource: Source<WorkspaceSpec> = {
      type: "resource",
      sourceId: "workspace-test",
      async start() {},
    };
    const repositorySource: Source<RepositorySpec> = {
      type: "resource",
      sourceId: "repository-test",
      async start() {},
    };
    const pullRequestSource: Source<PullRequestSpec> = {
      type: "resource",
      sourceId: "pull-request-test",
      async start() {},
    };
    const controllers = new Map<
      string,
      Controller<unknown, unknown>
    >();
    const context = {
      session: { batonSessionId: "bs_test", cwd: testRoot() },
      resources: {
        list() {
          return [];
        },
      },
      registerCommand() {},
      registerContextProvider() {},
      registerController(controller: Controller<unknown, unknown>) {
        controllers.set(controller.resourceType.kind, controller);
      },
    } as unknown as PluginActivationContext;

    await createReqloopPackage({
      requirementConnectors: [],
      forgeConnectors: [],
      workspaceSources: [workspaceSource],
      repositorySources: [repositorySource],
      pullRequestSources: [pullRequestSource],
      reviewConnector: {
        listLatest: async () => [],
        latest: async () => undefined,
      },
    }).activate(context);

    expect(controllers.get(REPOSITORY_RESOURCE_TYPE.kind)?.sources).toEqual([
      repositorySource,
    ]);
    expect(
      controllers.get(PULL_REQUEST_RESOURCE_TYPE.kind)?.sources?.[0],
    ).toBe(pullRequestSource);
    expect(controllers.get(WORKSPACE_RESOURCE_TYPE.kind)?.sources).toEqual([
      workspaceSource,
      {
        type: "cron",
        sourceId: "workspace-resync",
        cron: "*/30 * * * * *",
        timeZone: "UTC",
      },
    ]);
    expect(
      controllers.get(WORKSPACE_RESOURCE_TYPE.kind)?.watches?.map(
        ({ resourceType }) => resourceType,
      ),
    ).toEqual([
      REPOSITORY_RESOURCE_TYPE,
      PULL_REQUEST_RESOURCE_TYPE,
    ]);
    expect(
      controllers.get(REQUIREMENT_RESOURCE_TYPE.kind)?.watches?.map(
        ({ resourceType }) => resourceType,
      ),
    ).toEqual([PULL_REQUEST_RESOURCE_TYPE]);
    expect(
      controllers.get(PULL_REQUEST_RESOURCE_TYPE.kind)?.watches?.map(
        ({ resourceType }) => resourceType,
      ),
    ).toEqual([REQUIREMENT_RESOURCE_TYPE]);
    expect(
      controllers.get(REPOSITORY_RESOURCE_TYPE.kind)?.watches?.map(
        ({ resourceType }) => resourceType,
      ),
    ).toEqual([
      WORKSPACE_RESOURCE_TYPE,
      PULL_REQUEST_RESOURCE_TYPE,
    ]);
  });

  test("persists the activation baseline and proposes actionable follow-up", async () => {
    const root = testRoot();
    const path = historyPath(root);
    appendReview(path, {
      status: "success",
      sha: "baseline",
      count: 1,
      failed: 0,
      pull_request: {
        source: "github.com",
        repository: "owner/repo",
        number: 7,
      },
    });
    let headSha = "baseline";
    const connector = new DevloopReviewConnector(root, {
      historyPath: path,
      checkout: () => ({ headSha }),
    });
    let resource:
      | Resource<PullRequestSpec, PullRequestStatus>
      | undefined;
    let controller:
      | Controller<PullRequestSpec, PullRequestStatus>
      | undefined;

    const resources = {
      list(type: { apiVersion: string; kind: string }) {
        return type.kind === PULL_REQUEST_RESOURCE_TYPE.kind && resource
          ? [resource]
          : [];
      },
      create(
        type: { apiVersion: string; kind: string },
        input: { name: string; spec: PullRequestSpec },
      ) {
        resource = {
          ...type,
          metadata: {
            name: input.name,
            namespace: "pi_reqloop",
            uid: `uid-${input.name}`,
            generation: 1,
            resourceVersion: "1",
            creationTimestamp: new Date(0).toISOString(),
          },
          spec: input.spec,
          status: {},
        };
        return resource;
      },
      patchStatus(
        current: NonNullable<typeof resource>,
        patch: Partial<PullRequestStatus>,
      ) {
        resource = {
          ...current,
          metadata: {
            ...current.metadata,
            resourceVersion: String(
              Number(current.metadata.resourceVersion) + 1,
            ),
          },
          status: { ...current.status, ...patch },
        };
        return resource;
      },
    };
    const context = {
      instance: {
        pluginInstanceId: "pi_reqloop",
        batonSessionId: "bs_test",
        pluginId: reqloop.pluginId,
        packageVersion: reqloop.version,
        enabled: true,
        config: {},
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      },
      session: { batonSessionId: "bs_test", cwd: root },
      resources,
      registerCommand() {},
      registerContextProvider() {},
      registerController(
        candidate: Controller<unknown, unknown>,
      ) {
        if (
          candidate.resourceType.kind ===
            PULL_REQUEST_RESOURCE_TYPE.kind
        ) {
          controller = candidate as Controller<
            PullRequestSpec,
            PullRequestStatus
          >;
        }
      },
      onClose() {},
    } as unknown as PluginActivationContext;
    const plugin = createReqloopPackage({
      reviewConnector: connector,
      requirementConnectors: [],
      forgeConnectors: [],
    });

    await plugin.activate(context);
    expect(resource).toBeUndefined();
    expect(controller?.resourceType).toBe(PULL_REQUEST_RESOURCE_TYPE);
    expect(controller?.sources?.map(({ type, sourceId }) => ({
      type,
      sourceId,
    }))).toEqual([
      { type: "resource", sourceId: "forge" },
      { type: "resource", sourceId: "devloop" },
      { type: "cron", sourceId: "pull-request-poll" },
    ]);
    const identity = {
      source: "github.com",
      repository: "owner/repo",
      number: 7,
    };
    await resources.create(PULL_REQUEST_RESOURCE_TYPE, {
      name: pullRequestResourceId(identity),
      spec: { identity },
    });
    await controller!.reconcile(batonSnapshot(), resource!);
    expect(resource?.status.review?.sha).toBe("baseline");

    headSha = "new-review";
    appendReview(path, {
      status: "success",
      sha: "new-review",
      count: 1,
      failed: 0,
      pull_request: {
        source: "github.com",
        repository: "owner/repo",
        number: 7,
      },
      findings: [{ path: "src/app.ts", msg: "missing cancellation" }],
    });
    const result = await controller!.reconcile(batonSnapshot(), resource!);

    expect(resource?.status.review?.sha).toBe("new-review");
    expect(result?.output).toMatchObject({
      kind: "interaction",
      title: "Review comments found",
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
    if (result?.output?.kind !== "interaction") {
      throw new Error("expected review Interaction");
    }
    const decisionKey = result.output.decisionKey;
    const reviewKey = resource?.status.review?.key;
    if (!reviewKey) throw new Error("expected persisted review");
    const accepted = await controller!.reconcile(
      batonSnapshot([
        {
          interactionId: "ix_accept",
          decisionKey,
          resource: {
            ...PULL_REQUEST_RESOURCE_TYPE,
            namespace: resource!.metadata.namespace,
            name: resource!.metadata.name,
          },
          outcome: { kind: "answered", values: ["accept"] },
        },
      ]),
      resource!,
    );
    expect(resource?.status.reviewDecision).toEqual({
      reviewKey,
      choice: "accept",
    });
    expect(accepted?.output?.kind).toBe("proposed-input");
    if (accepted?.output?.kind !== "proposed-input") {
      throw new Error("expected review follow-up");
    }
    expect(accepted.output.text).toContain(
      "devloop review completed for owner/repo PR/MR 7",
    );
    expect(accepted.output.text).toContain("Fix the real findings");
    expect(accepted.output.text).toContain(
      "src/app.ts — missing cancellation",
    );
    expect(accepted.requeueAfterMs).toBeUndefined();
    expect(
      await controller!.reconcile(batonSnapshot(), resource!),
    ).toBeUndefined();
  });
});
