import type {
  PluginLogger,
  Resource,
  ResourceClient,
  ResourceNamespace,
  Source,
  SourceContext,
} from "@compforge/baton-plugin";

import type {
  ForgeConnector,
  PullRequestSpec,
  PullRequestStatus,
} from "../../pull-requests/protocol.ts";
import { PULL_REQUEST_RESOURCE_TYPE } from "../../pull-requests/resource.ts";
import {
  CODE_REVIEW_ACTIVE_TTL_MS,
  codeReviewExpiresAt,
  codeReviewObservations,
} from "../code-review.ts";
import type { CodeReviewSpec } from "../protocol.ts";
import {
  codeReviewResourceName,
  codeReviewSpec,
} from "../resource.ts";

const DEFAULT_MAX_PULL_REQUESTS = 20;
const DEFAULT_RESYNC_INTERVAL_MS = 60_000;

function positiveInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function observationTime(
  resource: Readonly<Resource<PullRequestSpec, PullRequestStatus>>,
): number {
  return Date.parse(
    resource.status.observedAt ?? resource.metadata.creationTimestamp,
  );
}

/**
 * Admits actionable devloop CodeReviews from Forge comments.
 *
 * A clean review intentionally posts no Forge comment, so it creates no active
 * CodeReview. The Forge remains the durable source of published findings.
 */
export class ForgeCodeReviewSource implements Source<CodeReviewSpec> {
  readonly type = "resource";
  readonly sourceId = "forge-code-review";
  private readonly connectors = new Map<string, ForgeConnector>();
  private readonly logger?: PluginLogger;
  private readonly maxPullRequests: number;
  private readonly namespace: ResourceNamespace;
  private readonly now: () => Date;
  private readonly resyncIntervalMs: number;
  private readonly ttlMs: number;
  private refreshing?: Promise<void>;

  constructor(
    private readonly resources: ResourceClient,
    connectors: readonly ForgeConnector[],
    options: {
      readonly codeReviewTtlMs?: number;
      readonly logger?: PluginLogger;
      readonly maxPullRequests?: number;
      readonly namespace?: ResourceNamespace;
      readonly now?: () => Date;
      readonly resyncIntervalMs?: number;
    } = {},
  ) {
    for (const connector of connectors) {
      if (this.connectors.has(connector.forge)) {
        throw new Error(`duplicate ForgeConnector: ${connector.forge}`);
      }
      this.connectors.set(connector.forge, connector);
    }
    this.logger = options.logger;
    this.maxPullRequests = positiveInteger(
      "ForgeCodeReviewSource maxPullRequests",
      options.maxPullRequests ?? DEFAULT_MAX_PULL_REQUESTS,
    );
    this.namespace = options.namespace ?? "v1";
    this.now = options.now ?? (() => new Date());
    this.resyncIntervalMs = positiveInteger(
      "ForgeCodeReviewSource resyncIntervalMs",
      options.resyncIntervalMs ?? DEFAULT_RESYNC_INTERVAL_MS,
    );
    this.ttlMs = positiveInteger(
      "ForgeCodeReviewSource codeReviewTtlMs",
      options.codeReviewTtlMs ?? CODE_REVIEW_ACTIVE_TTL_MS,
    );
  }

  async start(context: SourceContext<CodeReviewSpec>): Promise<void> {
    await this.refreshNow(context);
    if (context.signal.aborted) return;
    const timer = setInterval(() => {
      void this.refreshNow(context).catch(context.reportError);
    }, this.resyncIntervalMs);
    context.signal.addEventListener(
      "abort",
      () => clearInterval(timer),
      { once: true },
    );
  }

  /** Shared by periodic recovery and the devloop low-latency trigger. */
  async refreshNow(
    context: SourceContext<CodeReviewSpec>,
  ): Promise<void> {
    if (this.refreshing) return await this.refreshing;
    const refreshing = this.refresh(context);
    this.refreshing = refreshing;
    try {
      await refreshing;
    } finally {
      if (this.refreshing === refreshing) this.refreshing = undefined;
    }
  }

  private async refresh(
    context: SourceContext<CodeReviewSpec>,
  ): Promise<void> {
    const nowMs = this.now().getTime();
    if (!Number.isFinite(nowMs)) {
      throw new Error("CodeReview Source clock returned an invalid Date");
    }
    const pullRequests = (await this.resources.list<
      PullRequestSpec,
      PullRequestStatus
    >(PULL_REQUEST_RESOURCE_TYPE, { namespace: this.namespace }))
      .filter(({ status }) => status.lifecycle !== "closed")
      .sort((left, right) =>
        observationTime(right) - observationTime(left)
      )
      .slice(0, this.maxPullRequests);
    let admitted = 0;
    for (const pullRequest of pullRequests) {
      if (context.signal.aborted) return;
      const identity = pullRequest.spec.identity;
      const connector = this.connectors.get(identity.forge);
      if (!connector?.comments) continue;
      try {
        const comments = await connector.comments(identity);
        for (const observation of codeReviewObservations(identity, comments)) {
          if (codeReviewExpiresAt(observation, this.ttlMs) <= nowMs) continue;
          const spec = codeReviewSpec(observation);
          await context.emit({
            name: codeReviewResourceName(spec),
            namespace: this.namespace,
            spec,
          });
          admitted += 1;
        }
      } catch (error) {
        this.logger?.warn("Could not observe Forge review comments", {
          component: "code-review-source.forge",
          error,
          attributes: {
            pullRequest:
              `${identity.forge}/${identity.path}#${identity.number}`,
          },
        });
        context.reportError(error);
      }
    }
    this.logger?.info("Forge CodeReview discovery completed", {
      component: "code-review-source.forge",
      attributes: {
        inspectedPullRequests: pullRequests.length,
        admittedCodeReviews: admitted,
      },
    });
  }
}
