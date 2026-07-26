import type {
  PluginActivationContext,
  PluginPackage,
  PluginResource,
} from "@qiankun01/baton-plugin";

import {
  actionableReview,
  DevloopReviewConnector,
  reviewFollowUpText,
} from "./connectors/devloop-review.ts";
import type { RequirementConnector } from "./requirements/protocol.ts";
import { createRequirementsCommand } from "./requirements/command.ts";

export const REQLOOP_PLUGIN_ID = "qiankunli/reqloop";
export const REQLOOP_PACKAGE_VERSION = "0.1.2";
export const REQLOOP_REVIEW_WATCH_KIND = "reqloop.review-watch";
export const REQLOOP_REVIEW_WATCH_ID = "current-repo";
const REVIEW_POLL_INTERVAL_MS = 2_000;

interface ReviewWatchSpec {
  readonly repo: string;
}

interface ReviewWatchStatus {
  readonly observedReviewKey?: string;
  readonly observedSha?: string;
  readonly observedStatus?: string;
}

function currentRepo(context: PluginActivationContext): string {
  const cwd = context.session.cwd;
  if (!cwd?.trim()) {
    throw new Error("reqloop requires a BatonSession cwd");
  }
  return cwd;
}

function existingWatch(
  context: PluginActivationContext,
): Readonly<PluginResource<ReviewWatchSpec, ReviewWatchStatus>> | undefined {
  return context.resources
    .list<ReviewWatchSpec, ReviewWatchStatus>(REQLOOP_REVIEW_WATCH_KIND)
    .find(
      (resource) =>
        resource.metadata.resourceId === REQLOOP_REVIEW_WATCH_ID,
    );
}

export function createReqloopPackage(options: {
  connector?: DevloopReviewConnector;
  requirementConnector?: RequirementConnector;
} = {}): PluginPackage {
  return Object.freeze({
    pluginId: REQLOOP_PLUGIN_ID,
    version: REQLOOP_PACKAGE_VERSION,
    async activate(context: PluginActivationContext) {
      context.registerCommand(
        createRequirementsCommand(options.requirementConnector),
      );
      const repo = currentRepo(context);
      const connector = options.connector ?? new DevloopReviewConnector(repo);
      if (!connector.historyPath) return;

      let watch = existingWatch(context);
      if (!watch) {
        watch = context.resources.create<
          ReviewWatchSpec,
          ReviewWatchStatus
        >(REQLOOP_REVIEW_WATCH_KIND, {
          resourceId: REQLOOP_REVIEW_WATCH_ID,
          spec: { repo },
        });
        const baseline = connector.latest();
        if (baseline) {
          watch = context.resources.patchStatus(watch, {
            observedReviewKey: baseline.key,
            observedSha: baseline.sha,
            observedStatus: baseline.status,
          });
        }
      } else if (watch.spec.repo !== repo) {
        throw new Error(
          `reqloop review watch belongs to ${watch.spec.repo}, not ${repo}`,
        );
      }

      context.registerResource<ReviewWatchSpec, ReviewWatchStatus>({
        resourceKind: REQLOOP_REVIEW_WATCH_KIND,
        reconciler: {
          async reconcile(_baton, resource) {
            const observation = connector.latest();
            if (
              !observation ||
              observation.key === resource.status.observedReviewKey
            ) {
              return { requeueAfterMs: REVIEW_POLL_INTERVAL_MS };
            }
            context.resources.patchStatus(resource, {
              observedReviewKey: observation.key,
              observedSha: observation.sha,
              observedStatus: observation.status,
            });
            if (!actionableReview(observation)) {
              return { requeueAfterMs: REVIEW_POLL_INTERVAL_MS };
            }
            return {
              requeueAfterMs: REVIEW_POLL_INTERVAL_MS,
              output: {
                kind: "proposed-input",
                text: reviewFollowUpText(observation),
              },
            };
          },
        },
      });
    },
  });
}

const reqloop = createReqloopPackage();

export default reqloop;
export * from "./connectors/devloop-review.ts";
export * from "./requirements/protocol.ts";
