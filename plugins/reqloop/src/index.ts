import type {
  PluginContext,
  PluginPackage,
  Source,
} from "@compforge/baton-plugin";

import { reqloopConfigPaths } from "./config.ts";
import {
  createRepositoryController,
} from "./repositories/controller.ts";
import type {
  RepositorySpec,
} from "./repositories/protocol.ts";
import {
  WorkspaceRepositorySource,
} from "./repositories/sources/workspace.ts";
import {
  createCodeReviewController,
} from "./code-reviews/controller.ts";
import type { CodeReviewSpec } from "./code-reviews/protocol.ts";
import {
  ForgeCodeReviewSource,
} from "./code-reviews/sources/forge.ts";
import {
  DevloopCodeReviewSource,
} from "./code-reviews/sources/devloop.ts";
import type { RequirementConnector } from "./requirements/protocol.ts";
import { createRequirementsCommand } from "./requirements/command.ts";
import {
  createRequirementMention,
} from "./requirements/mention.ts";
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
} from "./pull-requests/protocol.ts";
import { DevloopPullRequestSource } from "./pull-requests/sources/devloop.ts";
import { ForgePullRequestSource } from "./pull-requests/sources/forge.ts";
import { DevloopToolActivityPolicy } from "./pull-requests/devloop-activity.ts";
import { createWorkspaceController } from "./workspaces/controller.ts";
import type { WorkspaceSpec } from "./workspaces/protocol.ts";
import { WorkspaceSource } from "./workspaces/source.ts";
import { withUserDeletionPolicy } from "./retention.ts";

export const REQLOOP_PLUGIN_ID = "compforge/reqloop";
export const REQLOOP_PACKAGE_VERSION = "0.2.14";

function currentRepo(context: PluginContext): string {
  const cwd = context.session.cwd;
  if (!cwd?.trim()) {
    throw new Error("reqloop requires a BatonSession cwd");
  }
  return cwd;
}

export function createReqloopPackage(options: {
  codeReviewSources?: readonly Source<CodeReviewSpec>[];
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
    async activate(context: PluginContext) {
      const requirementConnectors =
        options.requirementConnectors ??
        (options.requirementConnector
          ? [options.requirementConnector]
          : createMeegoRequirementConnectors(
            reqloopConfigPaths(context.dataDirs),
          ));
      context.commands.register(
        createRequirementsCommand(requirementConnectors, context.resources),
      );
      context.mentions.register(
        createRequirementMention(context.resources),
      );
      context.controllers.register(
        withUserDeletionPolicy(
          context.resources,
          createRequirementController(
            context.resources,
            requirementConnectors,
            context.toast,
          ),
        ),
      );
      const forgeConnectors =
        options.forgeConnectors ?? createForgeConnectors(
          reqloopConfigPaths(context.dataDirs),
        );
      const cwd = currentRepo(context);
      const toolActivity = new DevloopToolActivityPolicy(cwd);
      const workspaceSources =
        options.workspaceSources ?? [new WorkspaceSource(cwd)];
      const repositorySources = options.repositorySources ?? [
        new WorkspaceRepositorySource(cwd),
      ];
      const pullRequestSources = options.pullRequestSources ?? [
        new ForgePullRequestSource(cwd, forgeConnectors, {
          logger: context.logger,
          shouldTrack: ({ path }) => toolActivity.shouldTrackCheckout(path),
        }),
        new DevloopPullRequestSource(cwd, {
          logger: context.logger,
        }),
      ];
      context.controllers.register(
        withUserDeletionPolicy(
          context.resources,
          createPullRequestController(
            context.resources,
            forgeConnectors,
            pullRequestSources,
            (identity) => toolActivity.shouldTrackIdentity(identity),
          ),
        ),
      );
      const forgeCodeReviews = new ForgeCodeReviewSource(
        context.resources,
        forgeConnectors,
        { logger: context.logger },
      );
      const codeReviewSources = options.codeReviewSources ?? [
        forgeCodeReviews,
        new DevloopCodeReviewSource(cwd, forgeCodeReviews),
      ];
      context.controllers.register(
        withUserDeletionPolicy(
          context.resources,
          createCodeReviewController(
            context.resources,
            forgeConnectors,
            codeReviewSources,
          ),
        ),
      );
      context.controllers.register(
        withUserDeletionPolicy(
          context.resources,
          createRepositoryController(
            context.resources,
            forgeConnectors,
            repositorySources,
          ),
        ),
      );
      context.controllers.register(
        withUserDeletionPolicy(
          context.resources,
          createWorkspaceController(
            context.resources,
            cwd,
            workspaceSources,
          ),
        ),
      );
      context.logger.info("ReqLoop activated", {
        component: "lifecycle",
        attributes: {
          cwd,
          requirementConnectors: requirementConnectors.length,
          forgeConnectors: forgeConnectors.length,
        },
      });
    },
  });
}

const reqloop = createReqloopPackage();

export default reqloop;
export * from "./config.ts";
export * from "./repositories/controller.ts";
export * from "./repositories/protocol.ts";
export * from "./repositories/resource.ts";
export * from "./repositories/sources/workspace.ts";
export * from "./code-reviews/code-review.ts";
export * from "./code-reviews/controller.ts";
export * from "./code-reviews/protocol.ts";
export * from "./code-reviews/resource.ts";
export * from "./code-reviews/sources/devloop.ts";
export * from "./code-reviews/sources/forge.ts";
export * from "./pull-requests/sources/devloop.ts";
export * from "./pull-requests/sources/forge.ts";
export * from "./pull-requests/devloop-activity.ts";
export * from "./pull-requests/connectors/config.ts";
export * from "./pull-requests/connectors/github.ts";
export * from "./pull-requests/connectors/gitlab.ts";
export type { Fetch } from "./pull-requests/connectors/http.ts";
export * from "./pull-requests/controller.ts";
export * from "./pull-requests/protocol.ts";
export * from "./pull-requests/resource.ts";
export * from "./retention.ts";
export * from "./requirements/connectors/meego.ts";
export * from "./requirements/mention.ts";
export * from "./requirements/controller.ts";
export * from "./requirements/conditions.ts";
export * from "./requirements/protocol.ts";
export * from "./requirements/resource.ts";
export * from "./workspaces/controller.ts";
export * from "./workspaces/discovery.ts";
export * from "./workspaces/protocol.ts";
export * from "./workspaces/resource.ts";
export * from "./workspaces/source.ts";
