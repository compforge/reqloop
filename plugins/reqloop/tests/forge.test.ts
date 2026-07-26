import {
  afterEach,
  describe,
  expect,
  test,
} from "bun:test";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createForgeConnectors,
  GitHubForgeConnector,
  GitLabForgeConnector,
  loadForgeConfigs,
  type Fetch,
} from "../src/index.ts";

const roots: string[] = [];

function testRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "reqloop-forge-"));
  roots.push(root);
  return root;
}

function json(data: unknown, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: {
      "content-type": "application/json",
      ...headers,
    },
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("Forge config", () => {
  test("uses host-keyed providers and devloop token precedence", () => {
    const path = join(testRoot(), "reqloop.json");
    writeFileSync(path, JSON.stringify({
      version: 1,
      forges: {
        "github.com": {
          token: "configured-github",
        },
        "code.example.com": {
          type: "gitlab",
          api_host: "gitlab-api.example.com",
          token: "configured-gitlab",
        },
      },
    }));

    expect(loadForgeConfigs(path, {
      GITHUB_TOKEN: "environment-github",
      GITLAB_TOKEN: "environment-gitlab",
    })).toEqual([
      {
        source: "github.com",
        provider: "github",
        host: "github.com",
        token: "environment-github",
      },
      {
        source: "code.example.com",
        provider: "gitlab",
        host: "code.example.com",
        apiHost: "gitlab-api.example.com",
        token: "environment-gitlab",
      },
    ]);
  });

  test("creates only authenticated Forge connectors", () => {
    const path = join(testRoot(), "reqloop.json");
    writeFileSync(path, JSON.stringify({
      version: 1,
      forges: {
        "github.com": { type: "github" },
        "gitlab.example.com": {
          type: "gitlab",
          token: "configured",
        },
      },
    }));

    expect(createForgeConnectors(path, { environment: {} }).map(
      (connector) => [connector.source, connector.provider],
    )).toEqual([["gitlab.example.com", "gitlab"]]);
  });
});

describe("GitHubForgeConnector", () => {
  test("maps lifecycle, conflicts, review threads, and discovery", async () => {
    const calls: { url: string; headers: Headers }[] = [];
    const fetch: Fetch = async (input, init) => {
      const url = String(input);
      calls.push({ url, headers: new Headers(init?.headers) });
      if (url.endsWith("/pulls/17")) {
        return json({ number: 17, state: "open", mergeable: false });
      }
      if (url.endsWith("/graphql")) {
        return json({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [
                    {
                      id: "PRRT_1",
                      isResolved: true,
                      comments: {
                        nodes: [{
                          id: "PRRC_1",
                          updatedAt: "2026-07-26T07:00:00Z",
                        }],
                      },
                    },
                    {
                      id: "PRRT_2",
                      isResolved: false,
                      comments: {
                        nodes: [{
                          id: "PRRC_2",
                          updatedAt: "2026-07-26T07:30:00Z",
                        }],
                      },
                    },
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        });
      }
      if (url.includes("/pulls?")) {
        return json([{ number: 17 }, { number: 16 }]);
      }
      return new Response("not found", { status: 404 });
    };
    const connector = new GitHubForgeConnector({
      source: "github.com",
      provider: "github",
      host: "github.com",
      token: "secret",
    }, {
      fetch,
      now: () => new Date("2026-07-26T08:00:00.000Z"),
    });

    await expect(connector.get({
      source: "github.com",
      repository: "qiankunli/reqloop",
      number: 17,
    })).resolves.toEqual({
      identity: {
        source: "github.com",
        repository: "qiankunli/reqloop",
        number: 17,
      },
      lifecycle: "open",
      reviewThreads: "unresolved",
      reviewActivityKey: expect.any(String),
      mergeability: "conflicted",
      observedAt: "2026-07-26T08:00:00.000Z",
    });
    await expect(connector.list("qiankunli/reqloop", 2)).resolves.toEqual([
      {
        source: "github.com",
        repository: "qiankunli/reqloop",
        number: 17,
      },
      {
        source: "github.com",
        repository: "qiankunli/reqloop",
        number: 16,
      },
    ]);
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer secret");
    expect(calls.map((call) => call.url)).toContain(
      "https://api.github.com/graphql",
    );
  });

  test("keeps the observation when review thread API is unavailable", async () => {
    const fetch: Fetch = async (input) => {
      if (String(input).endsWith("/pulls/3")) {
        return json({
          number: 3,
          state: "closed",
          merged: true,
          mergeable: null,
        });
      }
      return new Response("forbidden", { status: 403 });
    };
    const connector = new GitHubForgeConnector({
      source: "github.com",
      provider: "github",
      host: "github.com",
      token: "secret",
    }, { fetch });

    await expect(connector.get({
      source: "github.com",
      repository: "owner/repo",
      number: 3,
    })).resolves.toMatchObject({
      lifecycle: "merged",
      reviewThreads: "unknown",
      mergeability: "unknown",
    });
  });

  test("changes the activity key when a review comment changes", async () => {
    let commentId = "PRRC_1";
    const fetch: Fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/pulls/5")) {
        return json({ number: 5, state: "open", mergeable: true });
      }
      if (url.endsWith("/graphql")) {
        return json({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [{
                    id: "PRRT_1",
                    isResolved: false,
                    comments: {
                      nodes: [{
                        id: commentId,
                        updatedAt: "2026-07-26T08:00:00Z",
                      }],
                    },
                  }],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        });
      }
      return new Response("not found", { status: 404 });
    };
    const connector = new GitHubForgeConnector({
      source: "github.com",
      provider: "github",
      host: "github.com",
      token: "secret",
    }, { fetch });
    const identity = {
      source: "github.com",
      repository: "owner/repo",
      number: 5,
    };

    const first = await connector.get(identity);
    commentId = "PRRC_2";
    const second = await connector.get(identity);

    expect(first.reviewActivityKey).toEqual(expect.any(String));
    expect(second.reviewActivityKey).toEqual(expect.any(String));
    expect(second.reviewActivityKey).not.toBe(first.reviewActivityKey);
  });
});

describe("GitLabForgeConnector", () => {
  test("maps MR state and counts only resolvable discussions", async () => {
    const calls: { url: string; headers: Headers }[] = [];
    const fetch: Fetch = async (input, init) => {
      const url = String(input);
      calls.push({ url, headers: new Headers(init?.headers) });
      if (url.endsWith("/merge_requests/9")) {
        return json({
          iid: 9,
          state: "opened",
          detailed_merge_status: "mergeable",
          has_conflicts: false,
        });
      }
      if (url.includes("/discussions?")) {
        return json([
          {
            id: "conversation",
            notes: [{
              id: 1,
              resolvable: false,
              resolved: false,
            }],
          },
          {
            id: "review",
            notes: [{
              id: 2,
              updated_at: "2026-07-26T08:30:00Z",
              resolvable: true,
              resolved: false,
            }],
          },
        ]);
      }
      if (url.includes("/merge_requests?")) {
        return json([{ iid: 9 }]);
      }
      return new Response("not found", { status: 404 });
    };
    const connector = new GitLabForgeConnector({
      source: "gitlab.example.com",
      provider: "gitlab",
      host: "gitlab.example.com",
      token: "secret",
    }, {
      fetch,
      now: () => new Date("2026-07-26T09:00:00.000Z"),
    });

    await expect(connector.get({
      source: "gitlab.example.com",
      repository: "group/subgroup/repo",
      number: 9,
    })).resolves.toEqual({
      identity: {
        source: "gitlab.example.com",
        repository: "group/subgroup/repo",
        number: 9,
      },
      lifecycle: "open",
      reviewThreads: "unresolved",
      reviewActivityKey: expect.any(String),
      mergeability: "ready",
      observedAt: "2026-07-26T09:00:00.000Z",
    });
    await expect(
      connector.list("group/subgroup/repo", 1),
    ).resolves.toHaveLength(1);
    expect(calls[0]?.headers.get("private-token")).toBe("secret");
    expect(calls.map((call) => call.url)).toContain(
      "https://gitlab.example.com/api/v4/projects/" +
        "group%2Fsubgroup%2Frepo/merge_requests/9",
    );
  });

  test("does not treat ordinary conversation notes as review threads", async () => {
    const fetch: Fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/merge_requests/4")) {
        return json({
          iid: 4,
          state: "closed",
          detailed_merge_status: "unchecked",
          has_conflicts: false,
        });
      }
      if (url.includes("/discussions?")) {
        return json([{
          id: "conversation",
          notes: [{
            id: 1,
            resolvable: false,
            resolved: false,
          }],
        }]);
      }
      return new Response("not found", { status: 404 });
    };
    const connector = new GitLabForgeConnector({
      source: "gitlab.example.com",
      provider: "gitlab",
      host: "gitlab.example.com",
      token: "secret",
    }, { fetch });

    await expect(connector.get({
      source: "gitlab.example.com",
      repository: "group/repo",
      number: 4,
    })).resolves.toMatchObject({
      lifecycle: "closed",
      reviewThreads: "none",
      mergeability: "unknown",
    });
  });
});
