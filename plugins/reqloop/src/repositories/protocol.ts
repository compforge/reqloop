import type {
  PullRequestIdentity,
} from "../pull-requests/protocol.ts";

export interface RepositoryIdentity {
  /** Configured ForgeConnector source. */
  readonly source: string;
  /** Provider-neutral repository identity, for example owner/repo. */
  readonly repository: string;
}

/**
 * Optional, best-effort source for discovering PullRequests in a Repository.
 * Forge observation remains authoritative after a Resource is materialized.
 */
export interface PullRequestDiscoverySource {
  readonly sourceId: string;
  discover(
    repository: RepositoryIdentity,
  ):
    | readonly PullRequestIdentity[]
    | Promise<readonly PullRequestIdentity[]>;
}

export interface RepositorySpec {
  readonly identity: RepositoryIdentity;
}

export interface RepositoryStatus {
  readonly lastScanAt?: string;
  readonly discoveredPullRequests?: number;
  readonly connectorAvailable?: boolean;
}
