import type {
  PluginActivationContext,
  PluginPackage,
  Source,
} from "@compforge/baton-plugin";

import {
  createRepositoryController,
} from "./repositories/controller.ts";
import type {
  RepositorySpec,
} from "./repositories/protocol.ts";
import {
  DevloopReviewConnector,
} from "./pull-requests/connectors/devloop-review.ts";
import type { RequirementConnector } from "./requirements/protocol.ts";
import { createRequirementsCommand } from "./requirements/command.ts";
import {
  createRequirementContextProvider,
} from "./requirements/context.ts";
import {
  createRequirementController,
} from "./requirements/controller.ts";
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
  PullRequestSpec,
  PullRequestReviewConnector,
} from "./pull-requests/protocol.ts";
import { upsertPullRequestReview } from "./pull-requests/resource.ts";
import { createWorkspaceController } from "./workspaces/controller.ts";
import { discoverWorkspaceRepositories } from "./workspaces/discovery.ts";
import type { WorkspaceSpec } from "./workspaces/protocol.ts";
import { WorkspaceSource } from "./workspaces/source.ts";

export const REQLOOP_PLUGIN_ID = "qiankunli/reqloop";
export const REQLOOP_PACKAGE_VERSION = "0.2.0";

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
  workspaceSources?: readonly Source<WorkspaceSpec>[];
  repositorySources?: readonly Source<RepositorySpec>[];
  pullRequestSources?: readonly Source<PullRequestSpec>[];
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
        createRequirementsCommand(requirementConnectors, context.resources),
      );
      context.registerContextProvider(
        createRequirementContextProvider(context.resources),
      );
      context.registerController(
        createRequirementController(
          context.resources,
          requirementConnectors,
          context.toast,
        ),
      );
      const forgeConnectors =
        options.forgeConnectors ?? createForgeConnectors();
      const cwd = currentRepo(context);
      const repositorySources = options.repositorySources ?? [];
      const pullRequestSources = options.pullRequestSources ?? [];
      const workspaceSources =
        options.workspaceSources ?? [new WorkspaceSource(cwd)];
      const reviewConnector =
        options.reviewConnector ??
        new DevloopReviewConnector(cwd, {
          workspaceCheckouts: async () =>
            (await discoverWorkspaceRepositories(cwd)).map(
              ({ path, identity }) => ({
                path,
                ...identity,
              }),
            ),
        });
      for (const reviewBaseline of await reviewConnector.listLatest()) {
        await upsertPullRequestReview(context.resources, reviewBaseline);
      }
      context.registerController(
        createPullRequestController(
          context.resources,
          forgeConnectors,
          reviewConnector,
          pullRequestSources,
        ),
      );
      context.registerController(
        createRepositoryController(
          context.resources,
          forgeConnectors,
          repositorySources,
        ),
      );
      context.registerController(
        createWorkspaceController(
          context.resources,
          cwd,
          workspaceSources,
        ),
      );
    },
  });
}

const reqloop = createReqloopPackage();

export default reqloop;
export * from "./config.ts";
export * from "./repositories/controller.ts";
export * from "./repositories/protocol.ts";
export * from "./repositories/resource.ts";
export * from "./repositories/sources/devloop.ts";
export * from "./pull-requests/sources/devloop.ts";
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
export * from "./requirements/context.ts";
export * from "./requirements/controller.ts";
export * from "./requirements/conditions.ts";
export * from "./requirements/protocol.ts";
export * from "./requirements/resource.ts";
export * from "./workspaces/controller.ts";
export * from "./workspaces/discovery.ts";
export * from "./workspaces/protocol.ts";
export * from "./workspaces/resource.ts";
export * from "./workspaces/source.ts";
