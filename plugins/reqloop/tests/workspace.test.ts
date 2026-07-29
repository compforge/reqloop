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
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  BatonSnapshot,
  Resource,
  ResourceClient,
  ResourceType,
  SourceContext,
} from "@compforge/baton-plugin";

import {
  createWorkspaceController,
  discoverWorkspaceRepositories,
  PULL_REQUEST_RESOURCE_TYPE,
  pullRequestResourceId,
  type PullRequestSpec,
  type PullRequestStatus,
  REPOSITORY_RESOURCE_TYPE,
  repositoryResourceName,
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
  const listResources = <TSpec, TStatus>(type: ResourceType) =>
    [...resources.values()]
      .filter((resource) =>
        resource.apiVersion === type.apiVersion &&
        resource.kind === type.kind
      ) as readonly Readonly<Resource<TSpec, TStatus>>[];
  const client: ResourceClient = {
    async get<TSpec, TStatus>(type: ResourceType, name: string) {
      const resource = resources.get(key(type, name));
      if (!resource) throw new Error(`missing Resource: ${type.kind}/${name}`);
      return resource as Readonly<Resource<TSpec, TStatus>>;
    },
    async list<TSpec, TStatus>(type: ResourceType) {
      return listResources<TSpec, TStatus>(type);
    },
    async create<TSpec, TStatus>(
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
    async delete(type: ResourceType, name: string) {
      resources.delete(key(type, name));
    },
    async patchMetadata<TSpec, TStatus>(
      current: Readonly<Resource<TSpec, TStatus>>,
      patch: {
        readonly labels?: Readonly<Record<string, string | null>>;
        readonly annotations?: Readonly<Record<string, string | null>>;
      },
    ) {
      const apply = (
        existing: Readonly<Record<string, string>> | undefined,
        changes: Readonly<Record<string, string | null>> | undefined,
      ): Readonly<Record<string, string>> | undefined => {
        if (changes === undefined) return existing;
        const next = { ...existing };
        for (const [name, value] of Object.entries(changes)) {
          if (value === null) delete next[name];
          else next[name] = value;
        }
        return Object.keys(next).length > 0 ? next : undefined;
      };
      const labels = apply(current.metadata.labels, patch.labels);
      const annotations = apply(
        current.metadata.annotations,
        patch.annotations,
      );
      const resource = {
        ...current,
        metadata: {
          ...current.metadata,
          resourceVersion: String(
            Number(current.metadata.resourceVersion) + 1,
          ),
          labels,
          annotations,
        },
      };
      resources.set(key(current, current.metadata.name), resource);
      return resource;
    },
    async patchStatus<TSpec, TStatus>(
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
    list: listResources,
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
  test("does not mistake directories inside a checkout for repositories", async () => {
    const root = testRoot();
    initializeRepository(root, "owner/root-repo");
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "node_modules"));

    expect(await discoverWorkspaceRepositories(root)).toEqual([{
      path: root,
      relativePath: ".",
      identity: {
        source: "github.com",
        repository: "owner/root-repo",
      },
    }]);
  });

  test("projects Source-materialized repositories and PullRequests", async () => {
    const root = testRoot();
    const direct = join(root, "repo-a");
    const target = testRoot();
    const linked = join(root, "repo-b");
    initializeRepository(direct, "owner/repo-a");
    initializeRepository(target, "owner/repo-b");
    symlinkSync(target, linked, "dir");

    const resources = memoryResourceClient();
    let workspace = await resources.client.create<
      WorkspaceSpec,
      WorkspaceStatus
    >(WORKSPACE_RESOURCE_TYPE, {
      name: WORKSPACE_RESOURCE_NAME,
      spec: workspaceSpec(),
    });
    for (const repository of ["owner/repo-a", "owner/repo-b"]) {
      const identity = { source: "github.com", repository };
      await resources.client.create<RepositorySpec, RepositoryStatus>(
        REPOSITORY_RESOURCE_TYPE,
        {
          name: repositoryResourceName(identity),
          spec: { identity },
        },
      );
    }
    const pullRequestIdentity = {
      source: "github.com",
      repository: "owner/repo-a",
      number: 7,
    };
    await resources.client.create<PullRequestSpec, PullRequestStatus>(
      PULL_REQUEST_RESOURCE_TYPE,
      {
        name: pullRequestResourceId(pullRequestIdentity),
        spec: { identity: pullRequestIdentity },
      },
    );
    const controller = createWorkspaceController(resources.client, root);

    await controller.reconcile(batonSnapshot(root), workspace);
    workspace = await resources.client.get(
      WORKSPACE_RESOURCE_TYPE,
      WORKSPACE_RESOURCE_NAME,
    );

    expect(
      workspace.status.repositories?.map((item) => item.relativePath),
    ).toEqual(["repo-a", "repo-b"]);
    expect(workspace.status.openPullRequests).toBe(1);

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
    expect(await controller.present?.(workspace)).toBeUndefined();

    const resourceVersion = workspace.metadata.resourceVersion;
    await controller.reconcile(batonSnapshot(root), workspace);
    expect(
      (await resources.client.get<WorkspaceSpec, WorkspaceStatus>(
        WORKSPACE_RESOURCE_TYPE,
        WORKSPACE_RESOURCE_NAME,
      )).metadata.resourceVersion,
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

    await source.start({
      signal: abort.signal,
      async emit(resource) {
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
