import { describe, expect, test } from "bun:test";

import type {
  Controller,
  Resource,
  ResourceClient,
  ResourceType,
} from "@compforge/baton-plugin";

import {
  DELETE_AFTER_ANNOTATION,
  withUserDeletionPolicy,
} from "../src/retention.ts";
import { reconcileContext, TEST_NAMESPACE } from "./reconcile-context.ts";

const TYPE = {
  apiVersion: "reqloop.baton.dev/v1alpha1",
  kind: "Example",
} as const;
const CONTEXT = reconcileContext().context;

function resource(
  deleteAfter?: string,
  deletionTimestamp?: string,
): Readonly<Resource<Record<string, never>, Record<string, never>>> {
  return {
    ...TYPE,
    metadata: {
      name: "example",
      namespace: TEST_NAMESPACE,
      uid: "pr_example",
      generation: 1,
      resourceVersion: "1",
      creationTimestamp: "2026-07-29T00:00:00.000Z",
      ...(deleteAfter === undefined
        ? {}
        : {
          annotations: {
            [DELETE_AFTER_ANNOTATION]: deleteAfter,
          },
        }),
      ...(deletionTimestamp === undefined ? {} : { deletionTimestamp }),
    },
    spec: {},
    status: {},
  };
}

function resourceClient(
  deleted: Array<{ readonly kind: string; readonly name: string }>,
): ResourceClient {
  return {
    namespace: TEST_NAMESPACE,
    async delete(type: ResourceType, name: string) {
      deleted.push({ kind: type.kind, name });
    },
  } as unknown as ResourceClient;
}

function controller(
  reconcile: Controller<
    Record<string, never>,
    Record<string, never>
  >["reconcile"],
): Controller<Record<string, never>, Record<string, never>> {
  return {
    resourceType: TYPE,
    reconcile,
  };
}

describe("reqloop user deletion policy", () => {
  test("requests deletion after the annotated deadline", async () => {
    const deleted: Array<{ readonly kind: string; readonly name: string }> = [];
    let reconciles = 0;
    const wrapped = withUserDeletionPolicy(
      resourceClient(deleted),
      controller(async () => {
        reconciles += 1;
      }),
      () => new Date("2026-07-30T00:00:00.000Z"),
    );

    expect(
      await wrapped.reconcile(
        CONTEXT,
        resource("2026-07-29T23:59:59.000Z"),
      ),
    ).toBeUndefined();
    expect(deleted).toEqual([{ kind: "Example", name: "example" }]);
    expect(reconciles).toBe(0);
  });

  test("schedules the deadline without replacing an earlier domain wakeup", async () => {
    const deleted: Array<{ readonly kind: string; readonly name: string }> = [];
    const now = () => new Date("2026-07-29T00:00:00.000Z");
    const deadline = "2026-07-29T00:00:05.000Z";
    const retentionFirst = withUserDeletionPolicy(
      resourceClient(deleted),
      controller(async () => ({ requeueAfterMs: 10_000 })),
      now,
    );
    const domainFirst = withUserDeletionPolicy(
      resourceClient(deleted),
      controller(async () => ({ requeueAfterMs: 1_000 })),
      now,
    );

    expect(
      await retentionFirst.reconcile(CONTEXT, resource(deadline)),
    ).toEqual({ requeueAfterMs: 5_000 });
    expect(
      await domainFirst.reconcile(CONTEXT, resource(deadline)),
    ).toEqual({ requeueAfterMs: 1_000 });
    expect(deleted).toEqual([]);
  });

  test("lets terminating Resources complete normal cleanup", async () => {
    const deleted: Array<{ readonly kind: string; readonly name: string }> = [];
    let reconciles = 0;
    const wrapped = withUserDeletionPolicy(
      resourceClient(deleted),
      controller(async () => {
        reconciles += 1;
      }),
      () => new Date("2026-07-30T00:00:00.000Z"),
    );

    await wrapped.reconcile(
      CONTEXT,
      resource(
        "2026-07-29T00:00:00.000Z",
        "2026-07-29T00:00:01.000Z",
      ),
    );
    expect(deleted).toEqual([]);
    expect(reconciles).toBe(1);
  });

  test("rejects an invalid deletion deadline with Resource context", async () => {
    const wrapped = withUserDeletionPolicy(
      resourceClient([]),
      controller(async () => {}),
    );

    await expect(
      wrapped.reconcile(CONTEXT, resource("later")),
    ).rejects.toThrow(
      `Example/example annotation ${DELETE_AFTER_ANNOTATION} must be an ISO timestamp`,
    );
  });
});
