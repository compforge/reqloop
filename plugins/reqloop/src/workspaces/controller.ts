import type {
  Controller,
  Resource,
  ResourceClient,
  ResourceRef,
  Source,
} from "@compforge/baton-plugin";

import { enqueueRequestsFromMapFunc } from "../event-handler.ts";
import {
  PULL_REQUEST_RESOURCE_TYPE,
  pullRequestResourceId,
} from "../pull-requests/resource.ts";
import type {
  PullRequestSpec,
  PullRequestStatus,
} from "../pull-requests/protocol.ts";
import type {
  RepositorySpec,
  RepositoryStatus,
} from "../repositories/protocol.ts";
import {
  repositoryResourceName,
  REPOSITORY_RESOURCE_TYPE,
} from "../repositories/resource.ts";
import { discoverWorkspaceRepositories } from "./discovery.ts";
import type {
  WorkspaceDiscoveryError,
  WorkspaceRepository,
  WorkspaceSpec,
  WorkspaceStatus,
} from "./protocol.ts";
import {
  WORKSPACE_RESOURCE_NAME,
  WORKSPACE_RESOURCE_TYPE,
} from "./resource.ts";

const WORKSPACE_RESYNC_CRON = "*/30 * * * * *";

const enqueueWorkspace = enqueueRequestsFromMapFunc<unknown, unknown>(
  async () => [{ name: WORKSPACE_RESOURCE_NAME }],
);

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
    watches: [
      {
        resourceType: REPOSITORY_RESOURCE_TYPE,
        handler: enqueueWorkspace,
      },
      {
        resourceType: PULL_REQUEST_RESOURCE_TYPE,
        handler: enqueueWorkspace,
      },
    ],
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
      const repositoryResources = await resources.list<
        RepositorySpec,
        RepositoryStatus
      >(REPOSITORY_RESOURCE_TYPE);
      const pullRequestResources = await resources.list<
        PullRequestSpec,
        PullRequestStatus
      >(PULL_REQUEST_RESOURCE_TYPE);
      for (const checkout of await discoverWorkspaceRepositories(root)) {
        const repositoryName = repositoryResourceName(checkout.identity);
        const repository = repositoryResources.find(({ metadata }) =>
          metadata.name === repositoryName
        );
        if (repository) {
          repositories.push({
            relativePath: checkout.relativePath,
            repository: resourceRef(repository),
          });
        }
        for (const pullRequest of pullRequestResources) {
          const { identity } = pullRequest.spec;
          if (
            identity.source === checkout.identity.source &&
            identity.repository === checkout.identity.repository &&
            pullRequest.status.lifecycle !== "merged" &&
            pullRequest.status.lifecycle !== "closed"
          ) {
            pullRequests.add(pullRequestResourceId(identity));
          }
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
      await resources.patchStatus(resource, {
        repositories,
        openPullRequests: pullRequests.size,
        discoveryErrors,
        observedAt: new Date().toISOString(),
      });
    },
    async present(resource) {
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
