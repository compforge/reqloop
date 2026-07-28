import {
  enqueueRequestsFromMapFunc,
  type Controller,
  type Resource,
  type ResourceClient,
  type Source,
} from "@qiankun01/baton-plugin";

import type { ForgeConnector } from "../pull-requests/protocol.ts";
import { ensurePullRequestResource } from "../pull-requests/resource.ts";
import type {
  WorkspaceSpec,
  WorkspaceStatus,
} from "../workspaces/protocol.ts";
import { WORKSPACE_RESOURCE_TYPE } from "../workspaces/resource.ts";
import type {
  RepositorySpec,
  RepositoryStatus,
} from "./protocol.ts";
import { REPOSITORY_RESOURCE_TYPE } from "./resource.ts";

const REPOSITORY_POLL_INTERVAL_MS = 30_000;

const enqueueWorkspaceRepositories = enqueueRequestsFromMapFunc<
  WorkspaceSpec,
  WorkspaceStatus
>((workspace) =>
  (workspace.status.repositories ?? []).flatMap(({ repository }) =>
    repository.apiVersion === REPOSITORY_RESOURCE_TYPE.apiVersion &&
      repository.kind === REPOSITORY_RESOURCE_TYPE.kind &&
      repository.namespace === workspace.metadata.namespace
      ? [{ name: repository.name }]
      : []
  )
);

function inWorkspace(
  resources: ResourceClient,
  repository: Readonly<Resource<RepositorySpec, RepositoryStatus>>,
): boolean {
  return resources
    .list<WorkspaceSpec, WorkspaceStatus>(WORKSPACE_RESOURCE_TYPE)
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

function nextScanDelay(lastScanAt: string | undefined): number | undefined {
  if (!lastScanAt) return;
  const elapsed = Date.now() - Date.parse(lastScanAt);
  if (!Number.isFinite(elapsed) || elapsed >= REPOSITORY_POLL_INTERVAL_MS) {
    return;
  }
  return Math.min(
    REPOSITORY_POLL_INTERVAL_MS,
    Math.max(1, REPOSITORY_POLL_INTERVAL_MS - elapsed),
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

  const directlyObserved = sources.length > 0;
  return {
    resourceType: REPOSITORY_RESOURCE_TYPE,
    watches: [{
      resourceType: WORKSPACE_RESOURCE_TYPE,
      handler: enqueueWorkspaceRepositories,
    }],
    ...(sources.length > 0 ? { sources } : {}),
    async reconcile(_baton, resource) {
      let current = resource;
      if (!directlyObserved && !inWorkspace(resources, current)) {
        if (current.status.inScope !== false) {
          resources.patchStatus(current, { inScope: false });
        }
        return;
      }
      if (current.status.inScope !== true) {
        current = resources.patchStatus(current, { inScope: true });
      }

      // Updating lastScanAt enqueues this Resource again. Restore the remaining
      // timer on that immediate reconcile instead of polling the Forge twice.
      const delay = nextScanDelay(current.status.lastScanAt);
      if (delay !== undefined) return { requeueAfterMs: delay };

      const { identity } = current.spec;
      const connector = connectorsBySource.get(identity.source);
      if (!connector) {
        resources.patchStatus(current, { connectorAvailable: false });
        return;
      }

      const pullRequests = await connector.list(identity.repository);
      for (const pullRequest of pullRequests) {
        if (
          pullRequest.source !== identity.source ||
          pullRequest.repository !== identity.repository
        ) {
          throw new Error(
            "ForgeConnector discovered a PullRequest outside its repository",
          );
        }
        ensurePullRequestResource(resources, pullRequest);
      }
      resources.patchStatus(current, {
        connectorAvailable: true,
        discoveredPullRequests: pullRequests.length,
        lastScanAt: new Date().toISOString(),
      });
      return { requeueAfterMs: REPOSITORY_POLL_INTERVAL_MS };
    },
    present(resource) {
      if (resource.status.inScope === false) return undefined;
      const { source, repository } = resource.spec.identity;
      return {
        title: repository,
        status: resource.status.connectorAvailable === false
          ? "Forge connector unavailable"
          : resource.status.lastScanAt
          ? `${resource.status.discoveredPullRequests ?? 0} tracked PR/MR`
          : "Waiting for first scan",
        detail: source,
        tone: resource.status.connectorAvailable === false
          ? "warning"
          : "muted",
      };
    },
  };
}
