import type {
  Controller,
  Resource,
  ResourceClient,
  ResourceRef,
  Source,
} from "@qiankun01/baton-plugin";

import {
  devloopStatePath,
  readOpenPullRequestNumbers,
} from "../pull-requests/devloop-state.ts";
import {
  ensurePullRequestResource,
  pullRequestResourceId,
} from "../pull-requests/resource.ts";
import {
  ensureRepositoryResource,
} from "../repositories/resource.ts";
import { discoverWorkspaceRepositories } from "./discovery.ts";
import type {
  WorkspaceDiscoveryError,
  WorkspaceRepository,
  WorkspaceSpec,
  WorkspaceStatus,
} from "./protocol.ts";
import { WORKSPACE_RESOURCE_TYPE } from "./resource.ts";

const WORKSPACE_RESYNC_CRON = "*/30 * * * * *";

function resourceRef<TSpec, TStatus>(
  resource: Readonly<Resource<TSpec, TStatus>>,
): ResourceRef {
  return {
    apiVersion: resource.apiVersion,
    kind: resource.kind,
    namespace: resource.metadata.namespace,
    name: resource.metadata.name,
    uid: resource.metadata.uid,
  };
}

function discoveryMessage(error: unknown, root: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replaceAll(root, ".");
}

function sameDiscovery(
  status: WorkspaceStatus,
  repositories: readonly WorkspaceRepository[],
  openPullRequests: number,
  discoveryErrors: readonly WorkspaceDiscoveryError[],
): boolean {
  return JSON.stringify({
    repositories: status.repositories ?? [],
    openPullRequests: status.openPullRequests ?? 0,
    discoveryErrors: status.discoveryErrors ?? [],
  }) === JSON.stringify({
    repositories,
    openPullRequests,
    discoveryErrors,
  });
}

export function createWorkspaceController(
  resources: ResourceClient,
  root: string,
  sources: readonly Source<WorkspaceSpec>[] = [],
): Controller<WorkspaceSpec, WorkspaceStatus> {
  return {
    resourceType: WORKSPACE_RESOURCE_TYPE,
    sources: [
      ...sources,
      {
        type: "cron",
        sourceId: "workspace-resync",
        cron: WORKSPACE_RESYNC_CRON,
        timeZone: "UTC",
      },
    ],
    async reconcile(_baton, resource) {
      if (resource.spec.root.kind !== "session-cwd") {
        throw new Error(
          `Unsupported Workspace root kind: ${resource.spec.root.kind}`,
        );
      }

      const repositories: WorkspaceRepository[] = [];
      const discoveryErrors: WorkspaceDiscoveryError[] = [];
      const pullRequests = new Set<string>();
      for (const checkout of discoverWorkspaceRepositories(root)) {
        const repository = ensureRepositoryResource(
          resources,
          checkout.identity,
        );
        repositories.push({
          relativePath: checkout.relativePath,
          repository: resourceRef(repository),
        });

        const path = devloopStatePath(checkout.path, "pr.json");
        if (!path) continue;
        try {
          for (const number of readOpenPullRequestNumbers(path)) {
            const identity = { ...checkout.identity, number };
            ensurePullRequestResource(resources, identity);
            pullRequests.add(pullRequestResourceId(identity));
          }
        } catch (error) {
          discoveryErrors.push({
            relativePath: checkout.relativePath,
            message: discoveryMessage(error, root),
          });
        }
      }

      if (
        sameDiscovery(
          resource.status,
          repositories,
          pullRequests.size,
          discoveryErrors,
        )
      ) {
        return;
      }
      resources.patchStatus(resource, {
        repositories,
        openPullRequests: pullRequests.size,
        discoveryErrors,
        observedAt: new Date().toISOString(),
      });
    },
    present(resource) {
      const repositoryCount = resource.status.repositories?.length ?? 0;
      const openPullRequests = resource.status.openPullRequests ?? 0;
      const discoveryErrors = resource.status.discoveryErrors?.length ?? 0;
      return {
        title: "Workspace",
        status:
          `${repositoryCount} repositories · ${openPullRequests} open PR/MR`,
        detail: discoveryErrors > 0
          ? `${discoveryErrors} discovery error(s)`
          : "BatonSession cwd",
        tone: discoveryErrors > 0 ? "warning" : "muted",
      };
    },
  };
}
