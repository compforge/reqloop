import type { ResourceRef } from "@qiankun01/baton-plugin";

export interface WorkspaceSpec {
  readonly root: {
    readonly kind: "session-cwd";
  };
}

export interface WorkspaceRepository {
  readonly relativePath: string;
  readonly repository: ResourceRef;
}

export interface WorkspaceDiscoveryError {
  readonly relativePath: string;
  readonly message: string;
}

export interface WorkspaceStatus {
  readonly repositories?: readonly WorkspaceRepository[];
  readonly openPullRequests?: number;
  readonly observedAt?: string;
  readonly discoveryErrors?: readonly WorkspaceDiscoveryError[];
}
