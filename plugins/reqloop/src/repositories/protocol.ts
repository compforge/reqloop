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
  /** Whether at least one current observation entry owns this Repository. */
  readonly inScope?: boolean;
  readonly discoveredPullRequests?: number;
  readonly connectorAvailable?: boolean;
}
