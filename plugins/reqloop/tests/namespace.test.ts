import { describe, expect, test } from "bun:test";
import type { Source } from "@compforge/baton-plugin";

import {
  namespaceSource,
  projectResourceNamespace,
} from "../src/namespace.ts";

describe("ReqLoop Resource namespace", () => {
  test("uses a stable project namespace without basename collisions", () => {
    const first = projectResourceNamespace("/work/one/project");
    const repeated = projectResourceNamespace("/work/one/project");
    const sameBasename = projectResourceNamespace("/work/two/project");

    expect(first).toBe(repeated);
    expect(first).toMatch(/^v1\/project\/project-[a-f0-9]{12}$/);
    expect(first).not.toBe(sameBasename);
  });

  test("places every Source observation in the selected namespace", async () => {
    const source: Source<{ readonly value: number }> = {
      type: "resource",
      sourceId: "test",
      async start(context) {
        await context.emit({
          name: "example",
          namespace: "v1",
          spec: { value: 1 },
        });
      },
    };
    const emitted: unknown[] = [];

    await namespaceSource(source, "v1/project/example").start({
      signal: new AbortController().signal,
      async emit(resource) {
        emitted.push(resource);
      },
      reportError(error) {
        throw error;
      },
    });

    expect(emitted).toEqual([{
      name: "example",
      namespace: "v1/project/example",
      spec: { value: 1 },
    }]);
  });
});
