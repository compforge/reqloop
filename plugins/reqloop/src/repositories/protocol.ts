export interface RepositoryIdentity {
  /** Configured ForgeConnector source. */
  readonly source: string;
  /** Provider-neutral repository identity, for example owner/repo. */
  readonly repository: string;
}

export interface RepositorySpec {
  readonly identity: RepositoryIdentity;
}

export interface RepositoryStatus {
  readonly lastScanAt?: string;
  readonly discoveredPullRequests?: number;
  readonly connectorAvailable?: boolean;
}
