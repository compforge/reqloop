import type {
  PluginActivationContext,
  PluginPackage,
} from "@qiankun01/baton-plugin";

import {
  DevloopReviewConnector,
} from "./pull-requests/connectors/devloop-review.ts";
import type { RequirementConnector } from "./requirements/protocol.ts";
import { createRequirementsCommand } from "./requirements/command.ts";
import {
  createMeegoRequirementConnectors,
} from "./requirements/connectors/meego.ts";
import {
  createPullRequestController,
} from "./pull-requests/controller.ts";
import {
  createForgeConnectors,
} from "./pull-requests/connectors/config.ts";
import type {
  ForgeConnector,
  PullRequestReviewConnector,
} from "./pull-requests/protocol.ts";
import { upsertPullRequestReview } from "./pull-requests/resource.ts";

export const REQLOOP_PLUGIN_ID = "qiankunli/reqloop";
export const REQLOOP_PACKAGE_VERSION = "0.1.5";

function currentRepo(context: PluginActivationContext): string {
  const cwd = context.session.cwd;
  if (!cwd?.trim()) {
    throw new Error("reqloop requires a BatonSession cwd");
  }
  return cwd;
}

export function createReqloopPackage(options: {
  reviewConnector?: PullRequestReviewConnector;
  requirementConnector?: RequirementConnector;
  requirementConnectors?: readonly RequirementConnector[];
  forgeConnectors?: readonly ForgeConnector[];
} = {}): PluginPackage {
  return Object.freeze({
    pluginId: REQLOOP_PLUGIN_ID,
    version: REQLOOP_PACKAGE_VERSION,
    async activate(context: PluginActivationContext) {
      const requirementConnectors =
        options.requirementConnectors ??
        (options.requirementConnector
          ? [options.requirementConnector]
          : createMeegoRequirementConnectors());
      context.registerCommand(
        createRequirementsCommand(requirementConnectors),
      );
      const forgeConnectors =
        options.forgeConnectors ?? createForgeConnectors();
      const reviewConnector =
        options.reviewConnector ??
        new DevloopReviewConnector(currentRepo(context));
      const reviewBaseline = reviewConnector.latest();
      if (reviewBaseline) {
        upsertPullRequestReview(context.resources, reviewBaseline);
      }
      context.registerController(
        createPullRequestController(
          context.resources,
          forgeConnectors,
          reviewConnector,
        ),
      );
    },
  });
}

const reqloop = createReqloopPackage();

export default reqloop;
export * from "./config.ts";
export * from "./pull-requests/connectors/config.ts";
export * from "./pull-requests/connectors/devloop-review.ts";
export * from "./pull-requests/connectors/github.ts";
export * from "./pull-requests/connectors/gitlab.ts";
export type { Fetch } from "./pull-requests/connectors/http.ts";
export * from "./pull-requests/controller.ts";
export * from "./pull-requests/protocol.ts";
export * from "./pull-requests/review.ts";
export * from "./pull-requests/resource.ts";
export * from "./requirements/connectors/meego.ts";
export * from "./requirements/protocol.ts";
