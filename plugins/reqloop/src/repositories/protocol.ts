/**
 * @spec A Repository is identified by one configured Forge and its provider-neutral path; transport URLs and provider types do not participate in identity.
 * @see {@link ../../docs/domain-model.md}
 */
export interface RepositoryIdentity {
  /** Configured ForgeConnector identity, often the Git host. */
  readonly forge: string;
  /** Provider-neutral repository path, for example owner/repo. */
  readonly path: string;
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
