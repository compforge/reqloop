import type {
  PluginActivationContext,
  PluginPackage,
} from "@qiankun01/baton-plugin";
import { spawnSync } from "node:child_process";

import {
  createRepositoryController,
} from "./repositories/controller.ts";
import type {
  RepositoryIdentity,
} from "./repositories/protocol.ts";
import {
  ensureRepositoryResource,
} from "./repositories/resource.ts";
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
  PullRequestReviewConnector,
} from "./pull-requests/protocol.ts";
import { upsertPullRequestReview } from "./pull-requests/resource.ts";

export const REQLOOP_PLUGIN_ID = "qiankunli/reqloop";
export const REQLOOP_PACKAGE_VERSION = "0.1.12";

function currentRepo(context: PluginActivationContext): string {
  const cwd = context.session.cwd;
  if (!cwd?.trim()) {
    throw new Error("reqloop requires a BatonSession cwd");
  }
  return cwd;
}

function currentRepository(
  cwd: string,
): RepositoryIdentity | undefined {
  const result = spawnSync(
    "git",
    ["remote", "get-url", "origin"],
    {
      cwd,
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  if (result.error || result.status !== 0) return;
  const remote = result.stdout?.toString().trim();
  if (!remote) return;

  let source: string;
  let repository: string;
  if (!remote.includes("://")) {
    const match = remote.match(/^(?:[^@]+@)?([^:]+):(.+)$/);
    if (!match) return;
    source = match[1]!;
    repository = match[2]!;
  } else {
    let url: URL;
    try {
      url = new URL(remote);
    } catch {
      return;
    }
    source = url.hostname;
    repository = url.pathname.replace(/^\/+/, "");
  }
  repository = repository.replace(/\.git$/, "");
  if (!source || !repository) return;
  return Object.freeze({ source, repository });
}

export function createReqloopPackage(options: {
  reviewConnector?: PullRequestReviewConnector;
  requirementConnector?: RequirementConnector;
  requirementConnectors?: readonly RequirementConnector[];
  forgeConnectors?: readonly ForgeConnector[];
  repositories?: readonly RepositoryIdentity[];
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
      const repositories =
        options.repositories ??
        [
          currentRepository(currentRepo(context)),
        ].filter(
          (
            repository,
          ): repository is RepositoryIdentity =>
            repository !== undefined,
        );
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
      context.registerController(
        createRepositoryController(
          context.resources,
          forgeConnectors,
        ),
      );
      for (const repository of repositories) {
        ensureRepositoryResource(context.resources, repository);
      }
    },
  });
}

const reqloop = createReqloopPackage();

export default reqloop;
export * from "./config.ts";
export * from "./repositories/controller.ts";
export * from "./repositories/protocol.ts";
export * from "./repositories/resource.ts";
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
