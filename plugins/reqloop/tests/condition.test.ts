import {
  expect,
  test,
} from "bun:test";

import type { ResourceCondition } from "@qiankun01/baton-plugin";

import { setStatusCondition } from "../src/index.ts";

const ready = {
  type: "ReadyToClose",
  status: "False",
  observedGeneration: 1,
  reason: "PullRequestsNotMerged",
  message: "A linked PullRequest is still open.",
} as const;

test("updates conditions immutably and only timestamps status transitions", () => {
  const initial = setStatusCondition(
    undefined,
    ready,
    "2026-07-27T01:00:00.000Z",
  );
  expect(initial).toEqual([{
    ...ready,
    lastTransitionTime: "2026-07-27T01:00:00.000Z",
  }]);

  const unchanged = setStatusCondition(
    initial,
    ready,
    "2026-07-27T02:00:00.000Z",
  );
  expect(unchanged).toBe(initial);

  const refreshed = setStatusCondition(
    initial,
    {
      ...ready,
      observedGeneration: 2,
      reason: "MergeConflicts",
      message: "A linked PullRequest has conflicts.",
    },
    "2026-07-27T03:00:00.000Z",
  );
  expect(refreshed).not.toBe(initial);
  expect(refreshed[0]?.lastTransitionTime).toBe(
    "2026-07-27T01:00:00.000Z",
  );

  const transitioned = setStatusCondition(
    refreshed,
    {
      ...ready,
      status: "True",
      observedGeneration: 2,
      reason: "PullRequestsSettled",
      message: "All linked PullRequests are settled.",
    } satisfies Omit<ResourceCondition, "lastTransitionTime">,
    "2026-07-27T04:00:00.000Z",
  );
  expect(transitioned[0]?.lastTransitionTime).toBe(
    "2026-07-27T04:00:00.000Z",
  );
  expect(initial[0]?.status).toBe("False");
});
