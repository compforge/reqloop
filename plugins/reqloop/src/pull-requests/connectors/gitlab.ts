import type {
  ForgeComment,
  ForgeConnector,
  PullRequestIdentity,
  PullRequestListQuery,
  PullRequestLifecycle,
  PullRequestMergeability,
  PullRequest,
  PullRequestReviewThreads,
} from "../protocol.ts";
import { isForgeRateLimitError } from "../protocol.ts";
import type { ForgeConfig } from "./config.ts";
import {
  JsonHttpClient,
  nonEmptyString,
  positiveLimit,
  record,
  records,
  reviewActivityKey,
  type Fetch,
} from "./http.ts";

const MAX_DISCUSSION_PAGES = 20;
const MAX_MERGE_REQUEST_PAGES = 20;
const MERGE_REQUEST_PAGE_SIZE = 100;

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

function authorMatches(
  mergeRequest: Record<string, unknown>,
  uids: readonly string[],
): boolean {
  const value = mergeRequest.author;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const author = value as Record<string, unknown>;
  return uids.some((uid) =>
    author.username === uid ||
    (author.id !== undefined && String(author.id) === uid)
  );
}

export class GitLabForgeConnector implements ForgeConnector {
  readonly source: string;
  readonly provider = "gitlab" as const;
  readonly #token: string;
  readonly #apiBase: string;
  readonly #http: JsonHttpClient;
  readonly #now: () => Date;
  readonly #uids?: readonly string[];

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
    this.#uids = config.uids;
    this.#apiBase = `https://${config.apiHost ?? config.host}/api/v4`;
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
      query.state === "open" ? "opened" : "merged",
      limit,
    );
  }

  async #listByState(
    repository: string,
    state: "opened" | "merged",
    limit?: number,
  ): Promise<readonly PullRequestIdentity[]> {
    const result: PullRequestIdentity[] = [];
    const seen = new Set<number>();
    let page = 1;
    for (
      let pageCount = 0;
      pageCount < MAX_MERGE_REQUEST_PAGES;
      pageCount += 1
    ) {
      const { data, headers } = await this.#http.request(
        "GET",
        `${this.#projectBase(repository)}` +
          `/merge_requests?state=${state}&order_by=updated_at&sort=desc` +
          this.#authorQuery() +
          `&per_page=${
            this.#uids && this.#uids.length > 1
              ? MERGE_REQUEST_PAGE_SIZE
              : Math.min(
                MERGE_REQUEST_PAGE_SIZE,
                limit ?? MERGE_REQUEST_PAGE_SIZE,
              )
          }` +
          `&page=${page}`,
        { headers: this.#headers() },
      );
      const mergeRequests = records("GitLab MergeRequests", data);
      for (const [index, mergeRequest] of mergeRequests.entries()) {
        if (mergeRequest.state !== state) continue;
        if (this.#uids && !authorMatches(mergeRequest, this.#uids)) continue;
        const number = mergeRequest.iid;
        if (!Number.isSafeInteger(number) || (number as number) < 1) {
          throw new Error(`GitLab MergeRequests[${index}].iid is invalid`);
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
      const nextPage = headers.get("x-next-page");
      if (!nextPage) return result;
      const parsed = Number(nextPage);
      if (!Number.isSafeInteger(parsed) || parsed <= page) {
        throw new Error("GitLab MergeRequest pagination is invalid");
      }
      page = parsed;
    }
    throw new Error(
      `GitLab ${state} MergeRequest pagination limit exceeded`,
    );
  }

  async get(identity: PullRequestIdentity): Promise<PullRequest> {
    this.#assertSource(identity);
    const { data } = await this.#http.request(
      "GET",
      `${this.#projectBase(identity.repository)}` +
        `/merge_requests/${identity.number}`,
      { headers: this.#headers() },
    );
    const mergeRequest = record("GitLab MergeRequest", data);
    let reviewThreads: PullRequestReviewThreads = "unknown";
    let reviewActivity: string | undefined;
    try {
      const observation = await this.#reviewThreads(identity);
      reviewThreads = observation.state;
      reviewActivity = observation.activityKey;
    } catch (error) {
      if (isForgeRateLimitError(error)) throw error;
      // Older or restricted GitLab instances may not expose discussions.
    }
    return {
      identity,
      title: nonEmptyString("GitLab MergeRequest.title", mergeRequest.title),
      url: nonEmptyString("GitLab MergeRequest.web_url", mergeRequest.web_url),
      lifecycle: lifecycle(mergeRequest),
      reviewThreads,
      ...(reviewActivity ? { reviewActivityKey: reviewActivity } : {}),
      mergeability: mergeability(mergeRequest),
      observedAt: this.#now().toISOString(),
    };
  }

  async comments(
    identity: PullRequestIdentity,
  ): Promise<readonly ForgeComment[]> {
    this.#assertSource(identity);
    const result: ForgeComment[] = [];
    let page = 1;
    for (let count = 0; count < MAX_DISCUSSION_PAGES; count += 1) {
      const { data, headers } = await this.#http.request(
        "GET",
        `${this.#projectBase(identity.repository)}` +
          `/merge_requests/${identity.number}/discussions` +
          `?per_page=100&page=${page}`,
        { headers: this.#headers() },
      );
      const discussions = records("GitLab discussions", data);
      for (const discussion of discussions) {
        const notes = records("GitLab discussion notes", discussion.notes)
          .filter((note) => note.system !== true);
        const root = notes[0];
        const threaded = discussion.individual_note !== true;
        for (const [index, note] of notes.entries()) {
          const id = note.id;
          if (
            (typeof id !== "number" && typeof id !== "string") ||
            id === ""
          ) {
            throw new Error(`GitLab comment ${index} has no id`);
          }
          const position = note.position &&
              typeof note.position === "object" &&
              !Array.isArray(note.position)
            ? note.position as Record<string, unknown>
            : undefined;
          const author = note.author &&
              typeof note.author === "object" &&
              !Array.isArray(note.author)
            ? note.author as Record<string, unknown>
            : undefined;
          const rootId = root?.id;
          const reply = threaded && rootId !== undefined && id !== rootId;
          result.push({
            id: String(id),
            body: typeof note.body === "string" ? note.body : "",
            ...(typeof author?.username === "string"
              ? { author: author.username }
              : {}),
            ...(threaded && typeof discussion.id === "string"
              ? { threadId: discussion.id }
              : {}),
            ...(reply ? { replyTo: String(rootId) } : {}),
            ...(typeof position?.new_path === "string"
              ? { path: position.new_path }
              : {}),
            ...(Number.isSafeInteger(position?.new_line)
              ? { line: position!.new_line as number }
              : {}),
            createdAt: nonEmptyString(
              `GitLab comment ${id} created_at`,
              note.created_at,
            ),
          });
        }
      }
      const nextPage = headers.get("x-next-page");
      if (!nextPage) {
        return result.sort((left, right) =>
          left.createdAt.localeCompare(right.createdAt)
        );
      }
      const parsed = Number(nextPage);
      if (!Number.isSafeInteger(parsed) || parsed <= page) {
        throw new Error("GitLab comment pagination is invalid");
      }
      page = parsed;
    }
    throw new Error("GitLab comment pagination limit exceeded");
  }

  #headers(): HeadersInit {
    return {
      Accept: "application/json",
      "PRIVATE-TOKEN": this.#token,
    };
  }

  #authorQuery(): string {
    if (this.#uids?.length !== 1) return "";
    const uid = this.#uids[0]!;
    const parameter = /^\d+$/.test(uid)
      ? "author_id"
      : "author_username";
    return `&${parameter}=${encodeURIComponent(uid)}`;
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
  ): Promise<{
    readonly state: PullRequestReviewThreads;
    readonly activityKey?: string;
  }> {
    let page = 1;
    const activityTokens: string[] = [];
    let unresolved = false;
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
        const resolvable = notes.filter((note) => note.resolvable === true);
        if (resolvable.length === 0) continue;
        if (typeof discussion.id !== "string" || !discussion.id) {
          throw new Error("GitLab review discussion has no id");
        }
        unresolved ||= resolvable.some((note) => note.resolved !== true);
        const noteTokens = notes.map((note) => {
          if (
            (typeof note.id !== "number" && typeof note.id !== "string") ||
            note.id === ""
          ) {
            throw new Error("GitLab review discussion note has no id");
          }
          if (
            note.updated_at !== undefined &&
            typeof note.updated_at !== "string"
          ) {
            throw new Error(
              "GitLab review discussion note updated_at is invalid",
            );
          }
          return [
            String(note.id),
            note.updated_at ?? null,
            note.resolvable === true,
            note.resolved === true,
          ];
        });
        activityTokens.push(JSON.stringify([discussion.id, noteTokens]));
      }

      const nextPage = headers.get("x-next-page");
      if (!nextPage) {
        if (activityTokens.length === 0) return { state: "none" };
        return {
          state: unresolved ? "unresolved" : "resolved",
          activityKey: reviewActivityKey("gitlab", activityTokens),
        };
      }
      const parsed = Number(nextPage);
      if (!Number.isSafeInteger(parsed) || parsed <= page) {
        throw new Error("GitLab discussion pagination is invalid");
      }
      page = parsed;
    }
    throw new Error("GitLab discussion pagination limit exceeded");
  }
}
