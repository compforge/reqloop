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
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadReqloopConfig,
  reqloopConfigPaths,
} from "../src/index.ts";

const roots: string[] = [];

function testRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "reqloop-config-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("ReqLoop scoped configuration", () => {
  test("requires config format version 2", () => {
    const path = join(testRoot(), "config.json");
    writeFileSync(path, JSON.stringify({ version: 1 }));

    expect(() => loadReqloopConfig(path)).toThrow(
      "reqloop config version must be 2",
    );
  });

  test("resolves only global, Project, and Session config paths", () => {
    expect(reqloopConfigPaths({
      global: "/global",
      project: "/project",
      session: "/session",
    })).toEqual([
      "/global/config.json",
      "/project/config.json",
      "/session/config.json",
    ]);
  });

  test("recursively overlays narrower scopes and skips missing files", () => {
    const root = testRoot();
    const global = join(root, "global");
    const project = join(root, "project");
    const session = join(root, "session");
    mkdirSync(global);
    mkdirSync(project);
    mkdirSync(session);
    writeFileSync(join(global, "config.json"), JSON.stringify({
      version: 2,
      forges: {
        "github.com": {
          type: "github",
          token: "global-token",
        },
      },
      requirements: {
        primary: {
          provider: "meego",
          projectKey: "global-project",
          categories: ["story", "issue"],
        },
      },
    }));
    writeFileSync(join(project, "config.json"), JSON.stringify({
      version: 2,
      forges: {
        "github.com": {
          api_host: "github.example.com",
        },
      },
      requirements: {
        primary: {
          projectKey: "workspace-project",
        },
      },
    }));

    expect(loadReqloopConfig(reqloopConfigPaths({
      global,
      project,
      session,
    }))).toEqual({
      version: 2,
      forges: {
        "github.com": {
          type: "github",
          token: "global-token",
          api_host: "github.example.com",
        },
      },
      requirements: {
        primary: {
          provider: "meego",
          projectKey: "workspace-project",
          categories: ["story", "issue"],
        },
      },
    });
  });
});
