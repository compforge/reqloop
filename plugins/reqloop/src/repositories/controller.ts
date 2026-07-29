import type {
  Controller,
  Resource,
  ResourceClient,
  Source,
} from "@compforge/baton-plugin";

import { enqueueRequestsFromMapFunc } from "../event-handler.ts";
import type {
  ForgeConnector,
  PullRequestSpec,
  PullRequestStatus,
} from "../pull-requests/protocol.ts";
import { PULL_REQUEST_RESOURCE_TYPE } from "../pull-requests/resource.ts";
import type {
  WorkspaceSpec,
  WorkspaceStatus,
} from "../workspaces/protocol.ts";
import { WORKSPACE_RESOURCE_TYPE } from "../workspaces/resource.ts";
import type {
  RepositorySpec,
  RepositoryStatus,
} from "./protocol.ts";
import {
  repositoryResourceName,
  REPOSITORY_RESOURCE_TYPE,
} from "./resource.ts";

const enqueueWorkspaceRepositories = enqueueRequestsFromMapFunc<
  WorkspaceSpec,
  WorkspaceStatus
>(async (workspace) =>
  (workspace.status.repositories ?? []).flatMap(({ repository }) =>
    repository.apiVersion === REPOSITORY_RESOURCE_TYPE.apiVersion &&
      repository.kind === REPOSITORY_RESOURCE_TYPE.kind &&
      repository.namespace === workspace.metadata.namespace
      ? [{ name: repository.name }]
      : []
  )
);

const enqueuePullRequestRepository = enqueueRequestsFromMapFunc<
  PullRequestSpec,
  PullRequestStatus
>(async (pullRequest) => [{
  name: repositoryResourceName(pullRequest.spec.identity),
}]);

async function inWorkspace(
  resources: ResourceClient,
  repository: Readonly<Resource<RepositorySpec, RepositoryStatus>>,
): Promise<boolean> {
  return (await resources
    .list<WorkspaceSpec, WorkspaceStatus>(WORKSPACE_RESOURCE_TYPE))
    .some((workspace) =>
      workspace.status.repositories?.some(({ repository: reference }) =>
        reference.apiVersion === repository.apiVersion &&
        reference.kind === repository.kind &&
        reference.namespace === repository.metadata.namespace &&
        reference.name === repository.metadata.name &&
        reference.uid === repository.metadata.uid
      ) ?? false
    );
}

export function createRepositoryController(
  resources: ResourceClient,
  connectors: readonly ForgeConnector[] = [],
  sources: readonly Source<RepositorySpec>[] = [],
): Controller<RepositorySpec, RepositoryStatus> {
  const connectorsBySource = new Map<string, ForgeConnector>();
  for (const connector of connectors) {
    if (connectorsBySource.has(connector.source)) {
      throw new Error(`duplicate ForgeConnector source: ${connector.source}`);
    }
    connectorsBySource.set(connector.source, connector);
  }

  return {
    resourceType: REPOSITORY_RESOURCE_TYPE,
    watches: [
      {
        resourceType: WORKSPACE_RESOURCE_TYPE,
        handler: enqueueWorkspaceRepositories,
      },
      {
        resourceType: PULL_REQUEST_RESOURCE_TYPE,
        handler: enqueuePullRequestRepository,
      },
    ],
    ...(sources.length > 0 ? { sources } : {}),
    async reconcile(_baton, resource) {
      let current = resource;
      if (!(await inWorkspace(resources, current))) {
        if (current.status.inScope !== false) {
          await resources.patchStatus(current, { inScope: false });
        }
        return;
      }
      if (current.status.inScope !== true) {
        current = await resources.patchStatus(current, { inScope: true });
      }

      const { identity } = current.spec;
      const discoveredPullRequests = (await resources.list<
        PullRequestSpec,
        PullRequestStatus
      >(PULL_REQUEST_RESOURCE_TYPE))
        .filter(({ spec }) =>
          spec.identity.source === identity.source &&
          spec.identity.repository === identity.repository
        )
        .length;
      const connectorAvailable = connectorsBySource.has(identity.source);
      if (
        current.status.connectorAvailable !== connectorAvailable ||
        current.status.discoveredPullRequests !== discoveredPullRequests
      ) {
        await resources.patchStatus(current, {
          connectorAvailable,
          discoveredPullRequests,
        });
      }
    },
    async present(resource) {
      if (resource.status.inScope === false) return undefined;
      const { source, repository } = resource.spec.identity;
      return {
        title: repository,
        status: resource.status.connectorAvailable === false
          ? "Forge connector unavailable"
          : `${resource.status.discoveredPullRequests ?? 0} tracked PR/MR`,
        detail: source,
        tone: resource.status.connectorAvailable === false
          ? "warning"
          : "muted",
      };
    },
  };
}
