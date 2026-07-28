import type {
  Controller,
  PluginLogger,
  ResourceClient,
} from "@qiankun01/baton-plugin";

import type {
  ForgeConnector,
  PullRequestIdentity,
} from "../pull-requests/protocol.ts";
import { ensurePullRequestResource } from "../pull-requests/resource.ts";
import type {
  PullRequestDiscoverySource,
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
  discoverySources: readonly PullRequestDiscoverySource[] = [],
  logger?: PluginLogger,
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
    async reconcile(_baton, resource) {
      // Updating lastScanAt enqueues this Resource again. Restore the remaining
      // timer on that immediate reconcile instead of polling the Forge twice.
      const delay = nextScanDelay(resource.status.lastScanAt);
      if (delay !== undefined) return { requeueAfterMs: delay };

      const { identity } = resource.spec;
      const discovered = new Map<number, PullRequestIdentity>();
      for (const source of discoverySources) {
        let pullRequests: readonly PullRequestIdentity[];
        try {
          pullRequests = await source.discover(identity);
        } catch (error) {
          try {
            logger?.write({
              level: "warn",
              component: "pull-request-discovery",
              message: "PullRequest discovery source failed",
              error,
              details: {
                sourceId: source.sourceId,
                forgeSource: identity.source,
                repository: identity.repository,
              },
            });
          } catch {
            // Diagnostics are best-effort; Forge discovery must still run.
          }
          continue;
        }
        for (const pullRequest of pullRequests) {
          if (
            pullRequest.source === identity.source &&
            pullRequest.repository === identity.repository
          ) {
            discovered.set(pullRequest.number, pullRequest);
          }
        }
      }

      const connector = connectorsBySource.get(identity.source);
      if (!connector) {
        for (const pullRequest of discovered.values()) {
          ensurePullRequestResource(resources, pullRequest);
        }
        resources.patchStatus(resource, { connectorAvailable: false });
        return discoverySources.length > 0
          ? { requeueAfterMs: REPOSITORY_POLL_INTERVAL_MS }
          : undefined;
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
        discovered.set(pullRequest.number, pullRequest);
      }
      for (const pullRequest of discovered.values()) {
        ensurePullRequestResource(resources, pullRequest);
      }
      resources.patchStatus(resource, {
        connectorAvailable: true,
        discoveredPullRequests: discovered.size,
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
