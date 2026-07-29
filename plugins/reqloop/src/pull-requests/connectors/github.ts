import type {
  ForgeConnector,
  PullRequestIdentity,
  PullRequestListQuery,
  PullRequestLifecycle,
  PullRequestMergeability,
  PullRequest,
  PullRequestReviewThreads,
} from "../protocol.ts";
import type { ForgeConfig } from "./config.ts";
import {
  JsonHttpClient,
  positiveLimit,
  record,
  records,
  reviewActivityKey,
  type Fetch,
} from "./http.ts";

const MAX_REVIEW_THREAD_PAGES = 20;
const MAX_PULL_REQUEST_PAGES = 20;
const PULL_REQUEST_PAGE_SIZE = 100;

export interface GitHubForgeConnectorOptions {
  readonly fetch?: Fetch;
  readonly now?: () => Date;
}

function repositoryPath(repository: string): string {
  const parts = repository.split("/");
  if (parts.length !== 2 || parts.some((part) => !part)) {
    throw new Error(
      `GitHub repository must be owner/repo, got ${repository}`,
    );
  }
  return parts.map(encodeURIComponent).join("/");
}

function lifecycle(pullRequest: Record<string, unknown>): PullRequestLifecycle {
  if (pullRequest.merged === true || pullRequest.merged_at) return "merged";
  if (pullRequest.state === "open") return "open";
  if (pullRequest.state === "closed") return "closed";
  throw new Error(`unknown GitHub PullRequest state: ${pullRequest.state}`);
}

function mergeability(
  pullRequest: Record<string, unknown>,
): PullRequestMergeability {
  if (pullRequest.mergeable === true) return "ready";
  if (pullRequest.mergeable === false) return "conflicted";
  return "unknown";
}

export class GitHubForgeConnector implements ForgeConnector {
  readonly source: string;
  readonly provider = "github" as const;
  readonly #token: string;
  readonly #restBase: string;
  readonly #graphqlUrl: string;
  readonly #http: JsonHttpClient;
  readonly #now: () => Date;

  constructor(
    config: ForgeConfig,
    options: GitHubForgeConnectorOptions = {},
  ) {
    if (config.provider !== "github") {
      throw new Error("GitHubForgeConnector requires a github config");
    }
    if (!config.token) throw new Error(`GitHub token missing for ${config.host}`);
    this.source = config.source;
    this.#token = config.token;
    const apiHost = config.apiHost ?? config.host;
    const restBase = apiHost === "github.com"
      ? "https://api.github.com"
      : `https://${apiHost}/api/v3`;
    this.#restBase = restBase;
    this.#graphqlUrl = restBase.endsWith("/api/v3")
      ? `${restBase.slice(0, -"/api/v3".length)}/api/graphql`
      : `${restBase}/graphql`;
    this.#http = new JsonHttpClient({ fetch: options.fetch });
    this.#now = options.now ?? (() => new Date());
  }

  async list(
    repository: string,
    query: PullRequestListQuery,
  ): Promise<readonly PullRequestIdentity[]> {
    const limit = positiveLimit(query.limit);
    return await this.#listByState(
      repository,
      query.state === "open" ? "open" : "closed",
      limit,
    );
  }

  async #listByState(
    repository: string,
    state: "open" | "closed",
    limit?: number,
  ): Promise<readonly PullRequestIdentity[]> {
    const result: PullRequestIdentity[] = [];
    const seen = new Set<number>();
    for (let page = 1; page <= MAX_PULL_REQUEST_PAGES; page += 1) {
      const { data, headers } = await this.#http.request(
        "GET",
        `${this.#restBase}/repos/${repositoryPath(repository)}` +
          `/pulls?state=${state}&sort=updated&direction=desc` +
          `&per_page=${Math.min(PULL_REQUEST_PAGE_SIZE, limit ?? PULL_REQUEST_PAGE_SIZE)}` +
          `&page=${page}`,
        { headers: this.#headers() },
      );
      const pullRequests = records("GitHub PullRequests", data);
      for (const [index, pullRequest] of pullRequests.entries()) {
        if (
          (state === "open" && pullRequest.state !== "open") ||
          (state === "closed" && !Boolean(pullRequest.merged_at))
        ) {
          continue;
        }
        const number = pullRequest.number;
        if (!Number.isSafeInteger(number) || (number as number) < 1) {
          throw new Error(`GitHub PullRequests[${index}].number is invalid`);
        }
        if (seen.has(number as number)) continue;
        seen.add(number as number);
        result.push({
          source: this.source,
          repository,
          number: number as number,
        });
        if (limit !== undefined && result.length === limit) return result;
      }
      const hasNextPage = headers.get("link")
        ?.split(",")
        .some((link) => /;\s*rel="next"/.test(link)) ?? false;
      if (!hasNextPage) return result;
    }
    throw new Error(
      `GitHub ${state} PullRequest pagination limit exceeded`,
    );
  }

  async get(identity: PullRequestIdentity): Promise<PullRequest> {
    this.#assertSource(identity);
    const { data } = await this.#http.request(
      "GET",
      `${this.#restBase}/repos/${repositoryPath(identity.repository)}` +
        `/pulls/${identity.number}`,
      { headers: this.#headers() },
    );
    const pullRequest = record("GitHub PullRequest", data);
    let reviewThreads: PullRequestReviewThreads = "unknown";
    let reviewActivity: string | undefined;
    try {
      const observation = await this.#reviewThreads(identity);
      reviewThreads = observation.state;
      reviewActivity = observation.activityKey;
    } catch {
      // Review thread support varies across GitHub Enterprise versions. A
      // partial observation is safer than treating ordinary comments as gates.
    }
    return {
      identity,
      lifecycle: lifecycle(pullRequest),
      reviewThreads,
      ...(reviewActivity ? { reviewActivityKey: reviewActivity } : {}),
      mergeability: mergeability(pullRequest),
      observedAt: this.#now().toISOString(),
    };
  }

  #headers(): HeadersInit {
    return {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${this.#token}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
  }

  #assertSource(identity: PullRequestIdentity): void {
    if (identity.source !== this.source) {
      throw new Error(
        `PullRequest source ${identity.source} does not match ${this.source}`,
      );
    }
  }

  async #reviewThreads(
    identity: PullRequestIdentity,
  ): Promise<{
    readonly state: PullRequestReviewThreads;
    readonly activityKey?: string;
  }> {
    const [owner, name] = identity.repository.split("/");
    let cursor: string | undefined;
    const activityTokens: string[] = [];
    let unresolved = false;
    for (let page = 0; page < MAX_REVIEW_THREAD_PAGES; page += 1) {
      const { data } = await this.#http.request(
        "POST",
        this.#graphqlUrl,
        {
          headers: this.#headers(),
          body: JSON.stringify({
            query: `query($owner:String!,$name:String!,$number:Int!,$after:String){
              repository(owner:$owner,name:$name){
                pullRequest(number:$number){
                  reviewThreads(first:100,after:$after){
                    nodes{
                      id
                      isResolved
                      comments(last:1){nodes{id updatedAt}}
                    }
                    pageInfo{hasNextPage endCursor}
                  }
                }
              }
            }`,
            variables: {
              owner,
              name,
              number: identity.number,
              after: cursor ?? null,
            },
          }),
        },
      );
      const root = record("GitHub GraphQL response", data);
      if (Array.isArray(root.errors) && root.errors.length > 0) {
        throw new Error("GitHub GraphQL returned errors");
      }
      const graph = record("GitHub GraphQL data", root.data);
      const repository = record("GitHub GraphQL repository", graph.repository);
      const pullRequest = record(
        "GitHub GraphQL PullRequest",
        repository.pullRequest,
      );
      const reviewThreads = record(
        "GitHub GraphQL reviewThreads",
        pullRequest.reviewThreads,
      );
      const nodes = records(
        "GitHub GraphQL reviewThreads.nodes",
        reviewThreads.nodes,
      );
      for (const thread of nodes) {
        if (typeof thread.id !== "string" || !thread.id) {
          throw new Error("GitHub review thread has no id");
        }
        if (typeof thread.isResolved !== "boolean") {
          throw new Error("GitHub review thread has no resolution state");
        }
        const comments = record(
          "GitHub GraphQL reviewThread.comments",
          thread.comments,
        );
        const commentNodes = records(
          "GitHub GraphQL reviewThread.comments.nodes",
          comments.nodes,
        );
        const latest = commentNodes.at(-1);
        const commentId = latest?.id;
        const updatedAt = latest?.updatedAt;
        if (latest && (typeof commentId !== "string" || !commentId)) {
          throw new Error("GitHub review comment has no id");
        }
        if (
          latest &&
          updatedAt !== undefined &&
          typeof updatedAt !== "string"
        ) {
          throw new Error("GitHub review comment updatedAt is invalid");
        }
        unresolved ||= thread.isResolved === false;
        activityTokens.push(JSON.stringify([
          thread.id,
          thread.isResolved,
          commentId ?? null,
          updatedAt ?? null,
        ]));
      }
      const pageInfo = record(
        "GitHub GraphQL reviewThreads.pageInfo",
        reviewThreads.pageInfo,
      );
      if (pageInfo.hasNextPage !== true) {
        if (activityTokens.length === 0) return { state: "none" };
        return {
          state: unresolved ? "unresolved" : "resolved",
          activityKey: reviewActivityKey("github", activityTokens),
        };
      }
      if (typeof pageInfo.endCursor !== "string" || !pageInfo.endCursor) {
        throw new Error("GitHub review thread cursor missing");
      }
      cursor = pageInfo.endCursor;
    }
    throw new Error("GitHub review thread pagination limit exceeded");
  }
}
