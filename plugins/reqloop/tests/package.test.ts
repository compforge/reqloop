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
  PluginActivationContext,
  PluginCommandContribution,
  PluginResource,
  ResourceContribution,
} from "@qiankun01/baton-plugin";

import reqloop, {
  createReqloopPackage,
  DevloopReviewConnector,
  loadMeegoRequirementConfigs,
  MeegleCliRequirementConnector,
  REQLOOP_REVIEW_WATCH_KIND,
  type RequirementConnector,
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

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("ReqLoop PluginPackage", () => {
  test("keeps its runtime identity aligned with Package metadata", () => {
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

  test("reads only the current checkout's latest terminal review", () => {
    const root = testRoot();
    const path = historyPath(root);
    appendReview(path, {
      ts: 1,
      status: "success",
      sha: "current-head",
      count: 1,
      failed: 0,
      findings: [{ path: "src/app.ts", msg: "missing cancellation" }],
    });
    appendReview(path, {
      ts: 2,
      status: "success",
      sha: "another-worktree",
      branch: "feature",
      count: 2,
      failed: 0,
    });
    const connector = new DevloopReviewConnector(root, {
      historyPath: path,
      checkout: () => ({ headSha: "current-head", branch: "feature" }),
    });

    expect(connector.latest()).toMatchObject({
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

  test("lists provider-neutral requirements and reads the selected requirement", async () => {
    const root = testRoot();
    const calls: string[] = [];
    const requirementConnector: RequirementConnector = {
      source: "meego",
      provider: "meego",
      async list(query) {
        calls.push(`list:${query?.text ?? ""}:${query?.limit ?? ""}`);
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
    let command: PluginCommandContribution | undefined;
    const context = {
      session: { batonSessionId: "bs_test", cwd: root },
      registerCommand(contribution: PluginCommandContribution) {
        command = contribution;
      },
    } as unknown as PluginActivationContext;

    await createReqloopPackage({ requirementConnector }).activate(context);
    expect(command).toMatchObject({
      commandId: "requirements",
      name: "requirements",
    });
    expect(await command!.execute({ argument: "intake" })).toEqual({
      kind: "picker",
      title: "Requirements · meego",
      options: [
        {
          name: "Add requirement intake",
          description: "meego · story · REQ-7 · in_progress",
          value: '["meego","story","REQ-7"]',
        },
      ],
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
    let command: PluginCommandContribution | undefined;
    const context = {
      session: { batonSessionId: "bs_test", cwd: testRoot() },
      registerCommand(contribution: PluginCommandContribution) {
        command = contribution;
      },
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

  test("persists the activation baseline and proposes actionable follow-up", async () => {
    const root = testRoot();
    const path = historyPath(root);
    appendReview(path, {
      status: "success",
      sha: "baseline",
      count: 1,
      failed: 0,
    });
    let headSha = "baseline";
    const connector = new DevloopReviewConnector(root, {
      historyPath: path,
      checkout: () => ({ headSha }),
    });
    let resource:
      | PluginResource<
          { repo: string },
          {
            observedReviewKey?: string;
            observedSha?: string;
            observedStatus?: string;
          }
        >
      | undefined;
    let resourceContribution:
      | ResourceContribution<
          { repo: string },
          {
            observedReviewKey?: string;
            observedSha?: string;
            observedStatus?: string;
          }
        >
      | undefined;

    const resources = {
      list() {
        return resource ? [resource] : [];
      },
      create(
        kind: string,
        input: { resourceId: string; spec: { repo: string } },
      ) {
        resource = {
          kind,
          metadata: {
            batonSessionId: "bs_test",
            pluginInstanceId: "pi_reqloop",
            resourceId: input.resourceId,
            generation: 1,
            resourceVersion: 1,
            createdAt: new Date(0).toISOString(),
            updatedAt: new Date(0).toISOString(),
          },
          spec: input.spec,
          status: {},
        };
        return resource;
      },
      patchStatus(
        current: NonNullable<typeof resource>,
        status: NonNullable<typeof resource>["status"],
      ) {
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
      registerResource(contribution: typeof resourceContribution) {
        resourceContribution = contribution;
      },
      watchBuiltinResource() {},
      onClose() {},
    } as unknown as PluginActivationContext;
    const plugin = createReqloopPackage({
      connector,
      requirementConnectors: [],
    });

    await plugin.activate(context);
    expect(resource?.status.observedSha).toBe("baseline");
    expect(resourceContribution?.resourceKind).toBe(
      REQLOOP_REVIEW_WATCH_KIND,
    );

    headSha = "new-review";
    appendReview(path, {
      status: "success",
      sha: "new-review",
      count: 1,
      failed: 0,
      pr_number: 7,
      findings: [{ path: "src/app.ts", msg: "missing cancellation" }],
    });
    const result = await resourceContribution!.reconciler.reconcile(
      {
        session: {
          batonSessionId: "bs_test",
          cwd: root,
          runState: "idle",
          revision: 0,
        },
        activeTurns: [],
        inputs: [],
        harnessTargets: [],
        pendingInteractions: [],
        turns: [],
      },
      resource!,
    );

    expect(resource?.status.observedSha).toBe("new-review");
    expect(result?.output?.text).toContain(
      "devloop review completed for PR/MR 7",
    );
    expect(result?.output?.text).toContain("Inspect the review comments");
    expect(result?.output?.text).toContain(
      "src/app.ts — missing cancellation",
    );
    expect(result?.requeueAfterMs).toBeGreaterThan(0);
  });
});
