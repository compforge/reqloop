import type {
  PluginLogger,
  Resource,
  ResourceClient,
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
  latestCodeReviewObservation,
} from "../code-review.ts";
import type { EvaluationSpec } from "../protocol.ts";
import {
  codeReviewEvaluationSpec,
  evaluationResourceName,
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
 * Admits actionable devloop code-review Evaluations from Forge comments.
 *
 * A clean review intentionally posts no Forge comment, so it creates no active
 * Evaluation. The Forge remains the durable source of published findings.
 */
export class ForgeEvaluationSource implements Source<EvaluationSpec> {
  readonly type = "resource";
  readonly sourceId = "forge-code-review";
  private readonly connectors = new Map<string, ForgeConnector>();
  private readonly logger?: PluginLogger;
  private readonly maxPullRequests: number;
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
      readonly now?: () => Date;
      readonly resyncIntervalMs?: number;
    } = {},
  ) {
    for (const connector of connectors) {
      if (this.connectors.has(connector.source)) {
        throw new Error(`duplicate ForgeConnector source: ${connector.source}`);
      }
      this.connectors.set(connector.source, connector);
    }
    this.logger = options.logger;
    this.maxPullRequests = positiveInteger(
      "ForgeEvaluationSource maxPullRequests",
      options.maxPullRequests ?? DEFAULT_MAX_PULL_REQUESTS,
    );
    this.now = options.now ?? (() => new Date());
    this.resyncIntervalMs = positiveInteger(
      "ForgeEvaluationSource resyncIntervalMs",
      options.resyncIntervalMs ?? DEFAULT_RESYNC_INTERVAL_MS,
    );
    this.ttlMs = positiveInteger(
      "ForgeEvaluationSource codeReviewTtlMs",
      options.codeReviewTtlMs ?? CODE_REVIEW_ACTIVE_TTL_MS,
    );
  }

  async start(context: SourceContext<EvaluationSpec>): Promise<void> {
    await this.runRefresh(context);
    if (context.signal.aborted) return;
    const timer = setInterval(() => {
      void this.runRefresh(context).catch(context.reportError);
    }, this.resyncIntervalMs);
    context.signal.addEventListener(
      "abort",
      () => clearInterval(timer),
      { once: true },
    );
  }

  private async runRefresh(
    context: SourceContext<EvaluationSpec>,
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
    context: SourceContext<EvaluationSpec>,
  ): Promise<void> {
    const nowMs = this.now().getTime();
    if (!Number.isFinite(nowMs)) {
      throw new Error("Evaluation Source clock returned an invalid Date");
    }
    const pullRequests = (await this.resources.list<
      PullRequestSpec,
      PullRequestStatus
    >(PULL_REQUEST_RESOURCE_TYPE))
      .filter(({ status }) => status.lifecycle !== "closed")
      .sort((left, right) =>
        observationTime(right) - observationTime(left)
      )
      .slice(0, this.maxPullRequests);
    let admitted = 0;
    for (const pullRequest of pullRequests) {
      if (context.signal.aborted) return;
      const identity = pullRequest.spec.identity;
      const connector = this.connectors.get(identity.source);
      if (!connector?.comments) continue;
      try {
        const comments = await connector.comments(identity);
        const observation = latestCodeReviewObservation(identity, comments);
        if (
          !observation ||
          codeReviewExpiresAt(observation, this.ttlMs) <= nowMs
        ) {
          continue;
        }
        const spec = codeReviewEvaluationSpec(observation);
        await context.emit({
          name: evaluationResourceName(spec),
          spec,
        });
        admitted += 1;
      } catch (error) {
        this.logger?.warn("Could not observe Forge review comments", {
          component: "evaluation-source.forge",
          error,
          attributes: {
            pullRequest:
              `${identity.source}/${identity.repository}#${identity.number}`,
          },
        });
        context.reportError(error);
      }
    }
    this.logger?.info("Forge Evaluation discovery completed", {
      component: "evaluation-source.forge",
      attributes: {
        inspectedPullRequests: pullRequests.length,
        admittedEvaluations: admitted,
      },
    });
  }
}
