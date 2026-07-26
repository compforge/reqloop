import type {
  ForgeConnector,
  PullRequestIdentity,
  PullRequestLifecycle,
  PullRequestMergeability,
  PullRequestObservation,
  PullRequestReviewThreads,
} from "../protocol.ts";
import type { ForgeConfig } from "./config.ts";
import {
  JsonHttpClient,
  positiveLimit,
  record,
  records,
  type Fetch,
} from "./http.ts";

const MAX_REVIEW_THREAD_PAGES = 20;

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
    limit?: number,
  ): Promise<readonly PullRequestIdentity[]> {
    const count = positiveLimit(limit);
    const { data } = await this.#http.request(
      "GET",
      `${this.#restBase}/repos/${repositoryPath(repository)}` +
        `/pulls?state=all&sort=created&direction=desc&per_page=${count}`,
      { headers: this.#headers() },
    );
    return records("GitHub PullRequests", data).map((pullRequest, index) => {
      const number = pullRequest.number;
      if (!Number.isSafeInteger(number) || (number as number) < 1) {
        throw new Error(`GitHub PullRequests[${index}].number is invalid`);
      }
      return {
        source: this.source,
        repository,
        number: number as number,
      };
    });
  }

  async get(identity: PullRequestIdentity): Promise<PullRequestObservation> {
    this.#assertSource(identity);
    const { data } = await this.#http.request(
      "GET",
      `${this.#restBase}/repos/${repositoryPath(identity.repository)}` +
        `/pulls/${identity.number}`,
      { headers: this.#headers() },
    );
    const pullRequest = record("GitHub PullRequest", data);
    let reviewThreads: PullRequestReviewThreads = "unknown";
    try {
      reviewThreads = await this.#reviewThreads(identity);
    } catch {
      // Review thread support varies across GitHub Enterprise versions. A
      // partial observation is safer than treating ordinary comments as gates.
    }
    return {
      identity,
      lifecycle: lifecycle(pullRequest),
      reviewThreads,
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
  ): Promise<PullRequestReviewThreads> {
    const [owner, name] = identity.repository.split("/");
    let cursor: string | undefined;
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
                    nodes{isResolved}
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
      if (nodes.some((thread) => thread.isResolved === false)) {
        return "unresolved";
      }
      if (nodes.some((thread) => thread.isResolved !== true)) {
        throw new Error("GitHub review thread has no resolution state");
      }
      const pageInfo = record(
        "GitHub GraphQL reviewThreads.pageInfo",
        reviewThreads.pageInfo,
      );
      if (pageInfo.hasNextPage !== true) return "resolved";
      if (typeof pageInfo.endCursor !== "string" || !pageInfo.endCursor) {
        throw new Error("GitHub review thread cursor missing");
      }
      cursor = pageInfo.endCursor;
    }
    throw new Error("GitHub review thread pagination limit exceeded");
  }
}
