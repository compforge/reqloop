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
      provider: "meego",
      async list(query) {
        calls.push(`list:${query?.text ?? ""}:${query?.limit ?? ""}`);
        return [
          {
            id: "REQ-7",
            title: "Add requirement intake",
            state: "in_progress",
          },
        ];
      },
      async get(requirementId) {
        calls.push(`get:${requirementId}`);
        return {
          id: requirementId,
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
          description: "REQ-7 · in_progress",
          value: "REQ-7",
        },
      ],
    });
    expect(
      await command!.execute({
        argument: "intake",
        selectedValue: "REQ-7",
      }),
    ).toMatchObject({
      kind: "message",
      text: expect.stringContaining("Acceptance criteria:\n- List requirements"),
    });
    expect(calls).toEqual(["list:intake:50", "get:REQ-7"]);
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
