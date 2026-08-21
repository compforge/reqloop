import type {
  PluginContext,
  PluginPackage,
  Source,
} from "@compforge/baton-plugin";

import {
  reqloopConfigPaths,
  reqloopGlobalConfigPath,
} from "./config.ts";
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
import { namespaceSource, projectResourceNamespace } from "./namespace.ts";
import {
  createComponentController,
  createEnvironmentController,
  createServiceController,
} from "./deployments/controller.ts";
import {
  deploymentCatalogSources,
  type DeploymentCatalog,
  loadDeploymentCatalog,
} from "./deployments/config.ts";
import {
  createKubernetesConnectors,
} from "./deployments/connectors/kubernetes.ts";
import type {
  ComponentSpec,
  EnvironmentSpec,
  KubernetesConnector,
  ServiceSpec,
} from "./deployments/protocol.ts";

export const REQLOOP_PLUGIN_ID = "compforge/reqloop";
export const REQLOOP_PACKAGE_VERSION = "0.3.1";

export function createReqloopPackage(options: {
  codeReviewSources?: readonly Source<CodeReviewSpec>[];
  componentSources?: readonly Source<ComponentSpec>[];
  deploymentCatalog?: DeploymentCatalog;
  environmentSources?: readonly Source<EnvironmentSpec>[];
  requirementConnector?: RequirementConnector;
  requirementConnectors?: readonly RequirementConnector[];
  forgeConnectors?: readonly ForgeConnector[];
  kubernetesConnectors?: readonly KubernetesConnector[];
  workspaceSources?: readonly Source<WorkspaceSpec>[];
  repositorySources?: readonly Source<RepositorySpec>[];
  pullRequestSources?: readonly Source<PullRequestSpec>[];
  serviceSources?: readonly Source<ServiceSpec>[];
} = {}): PluginPackage {
  const plugin: PluginPackage = Object.freeze({
    pluginId: REQLOOP_PLUGIN_ID,
    version: REQLOOP_PACKAGE_VERSION,
    async activate(context: PluginContext) {
      const globalConfigPath = reqloopGlobalConfigPath(context.dataDirs);
      const catalog = options.deploymentCatalog ??
        loadDeploymentCatalog(globalConfigPath);
      const catalogSources = deploymentCatalogSources(catalog);
      const kubernetesConnectors = options.kubernetesConnectors ??
        createKubernetesConnectors(globalConfigPath);
      context.controllers.register(createComponentController(
        options.componentSources ?? catalogSources.components,
      ));
      context.controllers.register(createEnvironmentController(
        context.resources,
        kubernetesConnectors,
        options.environmentSources ?? catalogSources.environments,
      ));
      context.controllers.register(createServiceController(
        context.resources,
        kubernetesConnectors,
        options.serviceSources ?? catalogSources.services,
      ));

      const cwd = context.session.cwd?.trim();
      if (!cwd) {
        context.logger.info("ReqLoop global deployment catalog activated", {
          component: "lifecycle",
          attributes: {
            components: catalog.components.length,
            environments: catalog.environments.length,
            services: catalog.services.length,
            kubernetesConnectors: kubernetesConnectors.length,
          },
        });
        return;
      }
      const projectNamespace = projectResourceNamespace(cwd);
      const requirementConnectors =
        options.requirementConnectors ??
        (options.requirementConnector
          ? [options.requirementConnector]
          : createMeegoRequirementConnectors(
            reqloopConfigPaths(context.dataDirs),
          ));
      context.commands.register(
        createRequirementsCommand(
          requirementConnectors,
          context.resources,
          projectNamespace,
        ),
      );
      context.mentions.register(
        createRequirementMention(context.resources, projectNamespace),
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
      const toolActivity = new DevloopToolActivityPolicy(cwd);
      const workspaceSources =
        (options.workspaceSources ?? [new WorkspaceSource(cwd)])
          .map((source) => namespaceSource(source, projectNamespace));
      const repositorySources = options.repositorySources ?? [
        new WorkspaceRepositorySource(cwd),
      ];
      const pullRequestSources = (options.pullRequestSources ?? [
        new ForgePullRequestSource(cwd, forgeConnectors, {
          logger: context.logger,
          shouldTrack: ({ path }) => toolActivity.shouldTrackCheckout(path),
        }),
        new DevloopPullRequestSource(cwd, {
          logger: context.logger,
        }),
      ]).map((source) => namespaceSource(source, projectNamespace));
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
        { logger: context.logger, namespace: projectNamespace },
      );
      const codeReviewSources = (options.codeReviewSources ?? [
        forgeCodeReviews,
        new DevloopCodeReviewSource(cwd, forgeCodeReviews),
      ]).map((source) => namespaceSource(source, projectNamespace));
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
            repositorySources.map((source) =>
              namespaceSource(source, projectNamespace)
            ),
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
          kubernetesConnectors: kubernetesConnectors.length,
        },
      });
    },
  });
  return plugin;
}

const reqloop = createReqloopPackage();

export default reqloop;
export * from "./config.ts";
export * from "./deployments/config.ts";
export * from "./deployments/connectors/kubernetes.ts";
export * from "./deployments/controller.ts";
export * from "./deployments/protocol.ts";
export * from "./deployments/resource.ts";
export * from "./namespace.ts";
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
