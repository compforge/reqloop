import type {
  Controller,
  ResourceClient,
  Source,
} from "@qiankun01/baton-plugin";

import type { ForgeConnector } from "../pull-requests/protocol.ts";
import { ensurePullRequestResource } from "../pull-requests/resource.ts";
import type {
  RepositorySpec,
  RepositoryStatus,
} from "./protocol.ts";
import { REPOSITORY_RESOURCE_TYPE } from "./resource.ts";

const REPOSITORY_POLL_INTERVAL_MS = 30_000;

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

  return {
    resourceType: REPOSITORY_RESOURCE_TYPE,
    ...(sources.length > 0 ? { sources } : {}),
    async reconcile(_baton, resource) {
      // Updating lastScanAt enqueues this Resource again. Restore the remaining
      // timer on that immediate reconcile instead of polling the Forge twice.
      const delay = nextScanDelay(resource.status.lastScanAt);
      if (delay !== undefined) return { requeueAfterMs: delay };

      const { identity } = resource.spec;
      const connector = connectorsBySource.get(identity.source);
      if (!connector) {
        resources.patchStatus(resource, { connectorAvailable: false });
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
      resources.patchStatus(resource, {
        connectorAvailable: true,
        discoveredPullRequests: pullRequests.length,
        lastScanAt: new Date().toISOString(),
      });
      return { requeueAfterMs: REPOSITORY_POLL_INTERVAL_MS };
    },
    present(resource) {
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
