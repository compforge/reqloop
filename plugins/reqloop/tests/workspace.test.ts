import {
  afterEach,
  describe,
  expect,
  test,
} from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type {
  BatonSnapshot,
  Resource,
  ResourceClient,
  ResourceType,
  SourceContext,
} from "@qiankun01/baton-plugin";

import {
  createWorkspaceController,
  discoverWorkspaceRepositories,
  PULL_REQUEST_RESOURCE_TYPE,
  type PullRequestSpec,
  type PullRequestStatus,
  REPOSITORY_RESOURCE_TYPE,
  type RepositorySpec,
  type RepositoryStatus,
  WORKSPACE_RESOURCE_NAME,
  WORKSPACE_RESOURCE_TYPE,
  type WorkspaceSpec,
  WorkspaceSource,
  type WorkspaceStatus,
  workspaceSpec,
} from "../src/index.ts";

const roots: string[] = [];

function testRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "reqloop-workspace-"));
  roots.push(root);
  return root;
}

function initializeRepository(root: string, repository: string): void {
  mkdirSync(root, { recursive: true });
  for (const args of [
    ["init"],
    ["remote", "add", "origin", `git@github.com:${repository}.git`],
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

function memoryResourceClient(): {
  readonly client: ResourceClient;
  readonly list: <TSpec, TStatus>(
    type: ResourceType,
  ) => readonly Readonly<Resource<TSpec, TStatus>>[];
} {
  const resources = new Map<string, Readonly<Resource<unknown, unknown>>>();
  const key = (type: ResourceType, name: string): string =>
    `${type.apiVersion}/${type.kind}/${name}`;
  const client: ResourceClient = {
    get<TSpec, TStatus>(type: ResourceType, name: string) {
      const resource = resources.get(key(type, name));
      if (!resource) throw new Error(`missing Resource: ${type.kind}/${name}`);
      return resource as Readonly<Resource<TSpec, TStatus>>;
    },
    list<TSpec, TStatus>(type: ResourceType) {
      return [...resources.values()]
        .filter((resource) =>
          resource.apiVersion === type.apiVersion &&
          resource.kind === type.kind
        ) as readonly Readonly<Resource<TSpec, TStatus>>[];
    },
    create<TSpec, TStatus>(
      type: ResourceType,
      input: { name: string; spec: TSpec },
    ) {
      const resource = {
        ...type,
        metadata: {
          name: input.name,
          namespace: "pi_reqloop",
          uid: `uid-${input.name}`,
          generation: 1,
          resourceVersion: "1",
          creationTimestamp: "2026-07-28T00:00:00.000Z",
        },
        spec: input.spec,
        status: {},
      } as Readonly<Resource<TSpec, TStatus>>;
      resources.set(key(type, input.name), resource);
      return resource;
    },
    delete(type: ResourceType, name: string) {
      resources.delete(key(type, name));
    },
    patchStatus<TSpec, TStatus>(
      current: Readonly<Resource<TSpec, TStatus>>,
      patch: Partial<TStatus>,
    ) {
      const resource = {
        ...current,
        metadata: {
          ...current.metadata,
          resourceVersion: String(
            Number(current.metadata.resourceVersion) + 1,
          ),
        },
        status: { ...current.status, ...patch },
      };
      resources.set(key(current, current.metadata.name), resource);
      return resource;
    },
  };
  return {
    client,
    list: <TSpec, TStatus>(type: ResourceType) =>
      client.list<TSpec, TStatus>(type),
  };
}

function batonSnapshot(cwd: string): BatonSnapshot {
  return {
    session: {
      batonSessionId: "bs_test",
      cwd,
      runState: "idle",
      revision: 0,
    },
    activeTurns: [],
    inputs: [],
    harnessTargets: [],
    pendingInteractions: [],
    pluginInteractions: [],
    turns: [],
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for workspace observation");
    }
    await Bun.sleep(10);
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("Workspace Resource", () => {
  test("does not mistake directories inside a checkout for repositories", () => {
    const root = testRoot();
    initializeRepository(root, "owner/root-repo");
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "node_modules"));

    expect(discoverWorkspaceRepositories(root)).toEqual([{
      path: root,
      relativePath: ".",
      identity: {
        source: "github.com",
        repository: "owner/root-repo",
      },
    }]);
  });

  test("discovers direct repositories and symlinks without recursive failure coupling", async () => {
    const root = testRoot();
    const direct = join(root, "repo-a");
    const target = testRoot();
    const linked = join(root, "repo-b");
    initializeRepository(direct, "owner/repo-a");
    initializeRepository(target, "owner/repo-b");
    symlinkSync(target, linked, "dir");

    const directState = join(direct, ".devloop", "pr.json");
    mkdirSync(dirname(directState), { recursive: true });
    writeFileSync(directState, JSON.stringify({
      prs: [
        { number: 7, state: "open" },
        { number: 6, state: "merged" },
      ],
    }));
    const linkedState = join(linked, ".devloop", "pr.json");
    mkdirSync(dirname(linkedState), { recursive: true });
    writeFileSync(linkedState, "{");

    const resources = memoryResourceClient();
    let workspace = resources.client.create<
      WorkspaceSpec,
      WorkspaceStatus
    >(WORKSPACE_RESOURCE_TYPE, {
      name: WORKSPACE_RESOURCE_NAME,
      spec: workspaceSpec(),
    });
    const controller = createWorkspaceController(resources.client, root);

    await controller.reconcile(batonSnapshot(root), workspace);
    workspace = resources.client.get(
      WORKSPACE_RESOURCE_TYPE,
      WORKSPACE_RESOURCE_NAME,
    );

    expect(
      workspace.status.repositories?.map((item) => item.relativePath),
    ).toEqual(["repo-a", "repo-b"]);
    expect(workspace.status.openPullRequests).toBe(1);
    expect(workspace.status.discoveryErrors).toEqual([{
      relativePath: "repo-b",
      message: expect.stringContaining(
        "Could not parse devloop PR state",
      ),
    }]);
    expect(workspace.status.discoveryErrors?.[0]?.message).not.toContain(
      root,
    );

    expect(
      resources.list<RepositorySpec, RepositoryStatus>(
        REPOSITORY_RESOURCE_TYPE,
      ).map((resource) => resource.spec.identity.repository).sort(),
    ).toEqual(["owner/repo-a", "owner/repo-b"]);
    expect(
      resources.list<PullRequestSpec, PullRequestStatus>(
        PULL_REQUEST_RESOURCE_TYPE,
      ).map((resource) => resource.spec.identity),
    ).toEqual([{
      source: "github.com",
      repository: "owner/repo-a",
      number: 7,
    }]);
    expect(controller.present?.(workspace)).toEqual({
      title: "Workspace",
      status: "2 repositories · 1 open PR/MR",
      detail: "1 discovery error(s)",
      tone: "warning",
    });

    const resourceVersion = workspace.metadata.resourceVersion;
    await controller.reconcile(batonSnapshot(root), workspace);
    expect(
      resources.client.get<WorkspaceSpec, WorkspaceStatus>(
        WORKSPACE_RESOURCE_TYPE,
        WORKSPACE_RESOURCE_NAME,
      ).metadata.resourceVersion,
    ).toBe(resourceVersion);
  });

  test("re-emits the singleton when direct children change", async () => {
    const root = testRoot();
    const emitted: Parameters<
      SourceContext<WorkspaceSpec>["emit"]
    >[0][] = [];
    const errors: unknown[] = [];
    const abort = new AbortController();
    const source = new WorkspaceSource(root, { watchIntervalMs: 10 });

    source.start({
      signal: abort.signal,
      emit(resource) {
        emitted.push(resource);
      },
      reportError(error) {
        errors.push(error);
      },
    });

    expect(emitted).toEqual([{
      name: WORKSPACE_RESOURCE_NAME,
      spec: workspaceSpec(),
    }]);
    mkdirSync(join(root, "new-checkout"));
    await waitFor(() => emitted.length > 1);
    abort.abort();

    expect(errors).toEqual([]);
    expect(emitted.at(-1)).toEqual({
      name: WORKSPACE_RESOURCE_NAME,
      spec: workspaceSpec(),
    });
  });
});
