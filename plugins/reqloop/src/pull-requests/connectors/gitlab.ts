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

const MAX_DISCUSSION_PAGES = 20;

export interface GitLabForgeConnectorOptions {
  readonly fetch?: Fetch;
  readonly now?: () => Date;
}

function lifecycle(mergeRequest: Record<string, unknown>): PullRequestLifecycle {
  switch (mergeRequest.state) {
    case "opened":
    case "open":
      return "open";
    case "merged":
      return "merged";
    case "closed":
    case "locked":
      return "closed";
    default:
      throw new Error(
        `unknown GitLab MergeRequest state: ${mergeRequest.state}`,
      );
  }
}

function mergeability(
  mergeRequest: Record<string, unknown>,
): PullRequestMergeability {
  if (
    mergeRequest.has_conflicts === true ||
    mergeRequest.detailed_merge_status === "conflict"
  ) {
    return "conflicted";
  }
  if (mergeRequest.detailed_merge_status === "mergeable") return "ready";
  return "unknown";
}

function encodedProject(repository: string): string {
  if (!repository.trim()) {
    throw new Error("GitLab repository must not be empty");
  }
  return encodeURIComponent(repository);
}

export class GitLabForgeConnector implements ForgeConnector {
  readonly source: string;
  readonly provider = "gitlab" as const;
  readonly #token: string;
  readonly #apiBase: string;
  readonly #http: JsonHttpClient;
  readonly #now: () => Date;

  constructor(
    config: ForgeConfig,
    options: GitLabForgeConnectorOptions = {},
  ) {
    if (config.provider !== "gitlab") {
      throw new Error("GitLabForgeConnector requires a gitlab config");
    }
    if (!config.token) throw new Error(`GitLab token missing for ${config.host}`);
    this.source = config.source;
    this.#token = config.token;
    this.#apiBase = `https://${config.apiHost ?? config.host}/api/v4`;
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
      `${this.#projectBase(repository)}` +
        `/merge_requests?state=all&order_by=created_at&sort=desc&per_page=${count}`,
      { headers: this.#headers() },
    );
    return records("GitLab MergeRequests", data).map(
      (mergeRequest, index) => {
        const number = mergeRequest.iid;
        if (!Number.isSafeInteger(number) || (number as number) < 1) {
          throw new Error(`GitLab MergeRequests[${index}].iid is invalid`);
        }
        return {
          source: this.source,
          repository,
          number: number as number,
        };
      },
    );
  }

  async get(identity: PullRequestIdentity): Promise<PullRequestObservation> {
    this.#assertSource(identity);
    const { data } = await this.#http.request(
      "GET",
      `${this.#projectBase(identity.repository)}` +
        `/merge_requests/${identity.number}`,
      { headers: this.#headers() },
    );
    const mergeRequest = record("GitLab MergeRequest", data);
    let reviewThreads: PullRequestReviewThreads = "unknown";
    try {
      reviewThreads = await this.#reviewThreads(identity);
    } catch {
      // Older or restricted GitLab instances may not expose discussions.
    }
    return {
      identity,
      lifecycle: lifecycle(mergeRequest),
      reviewThreads,
      mergeability: mergeability(mergeRequest),
      observedAt: this.#now().toISOString(),
    };
  }

  #headers(): HeadersInit {
    return {
      Accept: "application/json",
      "PRIVATE-TOKEN": this.#token,
    };
  }

  #projectBase(repository: string): string {
    return `${this.#apiBase}/projects/${encodedProject(repository)}`;
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
    let page = 1;
    for (let count = 0; count < MAX_DISCUSSION_PAGES; count += 1) {
      const { data, headers } = await this.#http.request(
        "GET",
        `${this.#projectBase(identity.repository)}` +
          `/merge_requests/${identity.number}/discussions?per_page=100&page=${page}`,
        { headers: this.#headers() },
      );
      const discussions = records("GitLab discussions", data);
      for (const discussion of discussions) {
        const notes = records("GitLab discussion notes", discussion.notes);
        // Only GitLab's resolvable review discussions are merge gates. Plain
        // conversation notes must not become unresolved review threads.
        if (
          notes.some(
            (note) =>
              note.resolvable === true &&
              note.resolved !== true,
          )
        ) {
          return "unresolved";
        }
      }

      const nextPage = headers.get("x-next-page");
      if (!nextPage) return "resolved";
      const parsed = Number(nextPage);
      if (!Number.isSafeInteger(parsed) || parsed <= page) {
        throw new Error("GitLab discussion pagination is invalid");
      }
      page = parsed;
    }
    throw new Error("GitLab discussion pagination limit exceeded");
  }
}
