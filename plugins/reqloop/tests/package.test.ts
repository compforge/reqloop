import {
  afterEach,
  describe,
  expect,
  test,
} from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type {
  Command,
  Controller,
  Mention,
  PluginContext,
  PluginLogContext,
  PluginLogger,
  PluginLogLevel,
  Source,
  SourceContext,
} from "@compforge/baton-plugin";

import reqloop, {
  CODE_REVIEW_RESOURCE_TYPE,
  type CodeReviewSpec,
  createReqloopPackage,
  DevloopCodeReviewSource,
  DevloopPullRequestSource,
  DevloopToolActivityPolicy,
  type ForgeConnector,
  ForgeCodeReviewSource,
  ForgePullRequestSource,
  interpretToolActivity,
  REPOSITORY_RESOURCE_TYPE,
  loadMeegoRequirementConfigs,
  MeegleCliRequirementConnector,
  PULL_REQUEST_RESOURCE_TYPE,
  type PullRequestSpec,
  type RepositorySpec,
  type RequirementConnector,
  REQUIREMENT_RESOURCE_TYPE,
  type WorkspaceSpec,
  WorkspaceRepositorySource,
  WorkspaceSource,
  WORKSPACE_RESOURCE_TYPE,
} from "../src/index.ts";

const roots: string[] = [];
const noopLogger: PluginLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

interface CapturedLog {
  readonly level: PluginLogLevel;
  readonly message: string;
  readonly context?: PluginLogContext;
}

function recordingLogger(logs: CapturedLog[]): PluginLogger {
  const capture = (level: PluginLogLevel) =>
    (message: string, context?: PluginLogContext): void => {
      logs.push({ level, message, context });
    };
  return {
    debug: capture("debug"),
    info: capture("info"),
    warn: capture("warn"),
    error: capture("error"),
  };
}

function testRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "reqloop-review-"));
  roots.push(root);
  return root;
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

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for source observation");
    }
    await Bun.sleep(10);
  }
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

  test("contributes the current checkout through the Workspace Source", async () => {
    const root = testRoot();
    initializeRepository(root);
    const emitted: Parameters<SourceContext<RepositorySpec>["emit"]>[0][] = [];
    const abort = new AbortController();
    const source = new WorkspaceRepositorySource(root, {
      resyncIntervalMs: 60_000,
    });

    await source.start({
      signal: abort.signal,
      async emit(resource) {
        emitted.push(resource);
      },
      reportError() {},
    });
    abort.abort();

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

  test("Workspace and Forge Sources own bounded Resource admission", async () => {
    const root = testRoot();
    initializeRepository(root);
    const repositoryEmits: Parameters<
      SourceContext<RepositorySpec>["emit"]
    >[0][] = [];
    const repositoryAbort = new AbortController();
    const repositorySource = new WorkspaceRepositorySource(root, {
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
    const logs: CapturedLog[] = [];
    const pullRequestAbort = new AbortController();
    const pullRequestSource = new ForgePullRequestSource(root, [forge], {
      logger: recordingLogger(logs),
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
    expect(logs).toEqual([
      expect.objectContaining({
        level: "debug",
        message: "Forge PullRequest discovery scope updated",
        context: expect.objectContaining({
          attributes: expect.objectContaining({
            trackedRepositories: 1,
          }),
        }),
      }),
      expect.objectContaining({
        level: "info",
        message: "Forge PullRequest discovery completed",
        context: expect.objectContaining({
          attributes: expect.objectContaining({
            admittedPullRequests: 1,
            discoveredPullRequests: 2,
          }),
        }),
      }),
      expect.objectContaining({
        level: "debug",
        message: "Discovered Forge PullRequests",
        context: expect.objectContaining({
          attributes: {
            pullRequests: ["github.com/compforge/reqloop#30"],
          },
        }),
      }),
    ]);
  });

  test("interprets only recent started tool calls and requires write dominance", () => {
    const now = Date.parse("2026-07-29T10:00:00.000Z");
    const event = (
      tool: string,
      ageMinutes: number,
      phase = "started",
    ) => JSON.stringify({
      schema: "devloop.tool-call/v1",
      kind: "tool_call",
      phase,
      ts: (now - ageMinutes * 60_000) / 1_000,
      tool,
    });

    expect(interpretToolActivity([
      event("Read", 5),
      event("apply_patch", 4),
      event("Write", 3),
      event("Write", 2, "finished"),
      event("Edit", 65),
      "{broken",
    ].join("\n"), now)).toEqual({
      started: 3,
      reads: 1,
      writes: 2,
      callsPerMinute: 0.05,
      trackPullRequests: true,
    });
    expect(interpretToolActivity([
      event("Read", 5),
      event("Grep", 4),
      event("Edit", 3),
    ].join("\n"), now).trackPullRequests).toBe(false);
  });

  test("reads the current checkout's rolling devloop activity file", async () => {
    const root = testRoot();
    initializeRepository(root);
    const directory = join(root, ".devloop");
    mkdirSync(directory);
    writeFileSync(join(directory, "tool-calls.jsonl"), [
      {
        schema: "devloop.tool-call/v1",
        kind: "tool_call",
        phase: "started",
        ts: Date.now() / 1_000,
        tool: "apply_patch",
      },
    ].map((event) => JSON.stringify(event)).join("\n"));

    const policy = new DevloopToolActivityPolicy(root);
    await expect(policy.shouldTrackCheckout(root)).resolves.toBe(true);
    await expect(policy.shouldTrackIdentity({
      source: "github.com",
      repository: "compforge/reqloop",
    })).resolves.toBe(true);
  });

  test("does not query Forge for a checkout rejected by tool activity", async () => {
    const root = testRoot();
    initializeRepository(root);
    let calls = 0;
    const forge: ForgeConnector = {
      source: "github.com",
      provider: "github",
      async list() {
        calls += 1;
        return [];
      },
      async get() {
        throw new Error("not used");
      },
    };
    const abort = new AbortController();
    const source = new ForgePullRequestSource(root, [forge], {
      resyncIntervalMs: 60_000,
      shouldTrack: async () => false,
    });
    await source.start({
      signal: abort.signal,
      async emit() {},
      reportError() {},
    });
    abort.abort();
    expect(calls).toBe(0);
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
    const logs: CapturedLog[] = [];
    const abort = new AbortController();
    const source = new DevloopPullRequestSource(root, {
      logger: recordingLogger(logs),
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
    expect(logs).toContainEqual(expect.objectContaining({
      level: "info",
      message: "Observed open PullRequests in devloop state",
      context: expect.objectContaining({
        attributes: expect.objectContaining({
          openPullRequests: 1,
        }),
      }),
    }));
    expect(logs).toContainEqual(expect.objectContaining({
      level: "debug",
      message: "Observed devloop PullRequest identities",
      context: expect.objectContaining({
        attributes: expect.objectContaining({
          pullRequests: [30],
          path,
        }),
      }),
    }));
    expect(logs).toContainEqual(expect.objectContaining({
      level: "warn",
      message: "Could not read devloop PR state",
      context: expect.objectContaining({
        error: expect.any(Error),
        attributes: { path },
      }),
    }));
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
    let mention: Mention | undefined;
    const resourceTypes: { apiVersion: string; kind: string }[] = [];
    const logs: CapturedLog[] = [];
    let workspaceController: Controller<unknown, unknown> | undefined;
    const context = {
      session: { batonSessionId: "bs_test", cwd: root },
      logger: recordingLogger(logs),
      commands: {
        register(contribution: Command) {
          command = contribution;
        },
      },
      mentions: {
        register(contribution: Mention) {
          mention = contribution;
        },
      },
      controllers: {
        register(controller: Controller<unknown, unknown>) {
          resourceTypes.push(controller.resourceType);
          if (controller.resourceType.kind === WORKSPACE_RESOURCE_TYPE.kind) {
            workspaceController = controller;
          }
        },
      },
    } as unknown as PluginContext;

    await createReqloopPackage({
      requirementConnector,
      forgeConnectors: [],
    }).activate(context);
    expect(command).toMatchObject({
      commandId: "requirements",
      name: "requirements",
    });
    expect(resourceTypes).toEqual([
      REQUIREMENT_RESOURCE_TYPE,
      PULL_REQUEST_RESOURCE_TYPE,
      CODE_REVIEW_RESOURCE_TYPE,
      REPOSITORY_RESOURCE_TYPE,
      WORKSPACE_RESOURCE_TYPE,
    ]);
    expect(workspaceController?.sources?.[0]).toBeInstanceOf(
      WorkspaceSource,
    );
    expect(logs).toContainEqual({
      level: "info",
      message: "ReqLoop activated",
      context: {
        component: "lifecycle",
        attributes: {
          cwd: root,
          requirementConnectors: 1,
          forgeConnectors: 0,
        },
      },
    });
    expect(mention?.namespace).toBe("requirement");
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

  test("loads multiple Meego requirement sources from config", () => {
    const path = join(testRoot(), "config.json");
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
            userKeys: ["ou_owner", "ou_backup"],
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
        userKeys: ["ou_owner", "ou_backup"],
        categories: ["story"],
      },
    ]);
  });

  test("optionally filters Meegle queries by participant", async () => {
    const mqls: string[] = [];
    const connector = (userKeys?: readonly string[]) =>
      new MeegleCliRequirementConnector(
        {
          source: "llmops",
          provider: "meego",
          projectKey: "llmops",
          ...(userKeys ? { userKeys } : {}),
          categories: ["story"],
        },
        async (args) => {
          const mqlIndex = args.indexOf("--mql");
          mqls.push(args[mqlIndex + 1]!);
          return [];
        },
      );

    await connector().list();
    await connector(["owner'key", "backup"]).list();

    expect(mqls[0]).not.toContain("participate_persons()");
    expect(mqls[1]).toContain(
      "array_contains(all_participate_persons(), '<id:owner''key>')",
    );
    expect(mqls[1]).toContain(
      "OR array_contains(all_participate_persons(), '<id:backup>')",
    );
    expect(mqls[1]).not.toContain(
      "array_contains(participate_persons(),",
    );
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
        if (args[0] === "config" && args[1] === "get") {
          return "meego.example";
        }
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
      url: "https://meego.example/llmops/story/detail/1001",
      description: "Normalize requirement platforms.",
      acceptanceCriteria: ["List requirements", "Read details"],
    });
    expect(calls).toHaveLength(4);
    expect(calls[0]).toContain("--profile");
    expect(calls[2]).toContain('["description"]');
    expect(calls[3]).toContain("host");
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
      logger: noopLogger,
      commands: {
        register(contribution: Command) {
          command = contribution;
        },
      },
      mentions: { register() {} },
      controllers: { register() {} },
    } as unknown as PluginContext;

    await createReqloopPackage({
      requirementConnectors: [
        connector("primary", "story", "REQ-1"),
        connector("secondary", "issue", "BUG-2"),
      ],
      forgeConnectors: [],
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
    const codeReviewSource: Source<CodeReviewSpec> = {
      type: "resource",
      sourceId: "code-review-test",
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
      logger: noopLogger,
      commands: { register() {} },
      mentions: { register() {} },
      controllers: {
        register(controller: Controller<unknown, unknown>) {
          controllers.set(controller.resourceType.kind, controller);
        },
      },
    } as unknown as PluginContext;

    await createReqloopPackage({
      requirementConnectors: [],
      forgeConnectors: [],
      workspaceSources: [workspaceSource],
      repositorySources: [repositorySource],
      pullRequestSources: [pullRequestSource],
      codeReviewSources: [codeReviewSource],
    }).activate(context);

    expect(controllers.get(REPOSITORY_RESOURCE_TYPE.kind)?.sources).toEqual([
      repositorySource,
    ]);
    expect(
      controllers.get(PULL_REQUEST_RESOURCE_TYPE.kind)?.sources?.[0],
    ).toBe(pullRequestSource);
    expect(
      controllers.get(CODE_REVIEW_RESOURCE_TYPE.kind)?.sources,
    ).toEqual([codeReviewSource]);
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
    ).toEqual([
      REQUIREMENT_RESOURCE_TYPE,
      CODE_REVIEW_RESOURCE_TYPE,
    ]);
    expect(
      controllers.get(REPOSITORY_RESOURCE_TYPE.kind)?.watches?.map(
        ({ resourceType }) => resourceType,
      ),
    ).toEqual([
      WORKSPACE_RESOURCE_TYPE,
      PULL_REQUEST_RESOURCE_TYPE,
    ]);

    await createReqloopPackage({
      requirementConnectors: [],
      forgeConnectors: [],
    }).activate(context);
    expect(
      controllers.get(REPOSITORY_RESOURCE_TYPE.kind)?.sources?.map(
        ({ type, sourceId }) => ({ type, sourceId }),
      ),
    ).toEqual([
      { type: "resource", sourceId: "workspace" },
    ]);
    const defaultCodeReviewSources =
      controllers.get(CODE_REVIEW_RESOURCE_TYPE.kind)?.sources;
    expect(defaultCodeReviewSources?.[0]).toBeInstanceOf(
      ForgeCodeReviewSource,
    );
    expect(defaultCodeReviewSources?.[1]).toBeInstanceOf(
      DevloopCodeReviewSource,
    );
  });

});
