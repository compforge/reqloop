import {
  describe,
  expect,
  test,
} from "bun:test";

import type {
  Resource,
  ResourceClient,
} from "@qiankun01/baton-plugin";

import {
  createPullRequestController,
  type ForgeConnector,
  PULL_REQUEST_RESOURCE_KIND,
  pullRequestResourceId,
  type PullRequestObservation,
  type PullRequestSpec,
  type PullRequestStatus,
  upsertPullRequestObservation,
} from "../src/index.ts";

function resourceClient(): {
  readonly client: ResourceClient;
  readonly current: () => Readonly<
    Resource<PullRequestSpec, PullRequestStatus>
  > | undefined;
} {
  let resource:
    | Readonly<Resource<PullRequestSpec, PullRequestStatus>>
    | undefined;
  const client = {
    list() {
      return resource ? [resource] : [];
    },
    create(
      kind: string,
      input: { resourceId: string; spec: PullRequestSpec },
    ) {
      resource = {
        kind,
        metadata: {
          resourceId: input.resourceId,
          batonSessionId: "bs_test",
          pluginInstanceId: "pi_reqloop",
          generation: 1,
          resourceVersion: 1,
          createdAt: "2026-07-26T00:00:00.000Z",
          updatedAt: "2026-07-26T00:00:00.000Z",
        },
        spec: input.spec,
        status: {},
      };
      return resource;
    },
    patchStatus(
      current: Readonly<Resource<PullRequestSpec, PullRequestStatus>>,
      patch: Partial<PullRequestStatus>,
    ) {
      const status = { ...current.status, ...patch };
      if (JSON.stringify(current.status) === JSON.stringify(status)) {
        return current;
      }
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
  } as unknown as ResourceClient;
  return { client, current: () => resource };
}

const observation: PullRequestObservation = {
  identity: {
    source: "github-primary",
    repository: "qiankunli/reqloop",
    number: 17,
  },
  lifecycle: "open",
  reviewThreads: "unresolved",
  mergeability: "ready",
  observedAt: "2026-07-26T08:00:00.000Z",
};

describe("PullRequest Resource", () => {
  test("uses one stable Resource for repeated external observations", () => {
    const resources = resourceClient();

    const created = upsertPullRequestObservation(
      resources.client,
      observation,
    );
    const repeated = upsertPullRequestObservation(
      resources.client,
      observation,
    );

    expect(created.kind).toBe(PULL_REQUEST_RESOURCE_KIND);
    expect(created.metadata.resourceId).toBe(
      pullRequestResourceId(observation.identity),
    );
    expect(created.spec).toEqual({ identity: observation.identity });
    expect(created.status).toEqual({
      lifecycle: "open",
      reviewThreads: "unresolved",
      mergeability: "ready",
      observedAt: "2026-07-26T08:00:00.000Z",
    });
    expect(repeated.metadata.resourceVersion).toBe(
      created.metadata.resourceVersion,
    );
    expect(resources.current()).toEqual(repeated);
  });

  test("keeps PullRequest as a supporting Resource outside the Board", () => {
    const controller = createPullRequestController();

    expect(controller.resourceKind).toBe(PULL_REQUEST_RESOURCE_KIND);
    expect(controller.present).toBeUndefined();
  });

  test("refreshes a PullRequest through its configured Forge", async () => {
    const resources = resourceClient();
    const pullRequest = upsertPullRequestObservation(
      resources.client,
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
      lifecycle: "merged",
      reviewThreads: "resolved",
      mergeability: "ready",
      observedAt: "2026-07-26T10:00:00.000Z",
    });
  });
});
