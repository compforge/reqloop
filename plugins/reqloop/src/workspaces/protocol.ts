import type { ResourceRef } from "@compforge/baton-plugin";

export interface WorkspaceSpec {
  readonly root: {
    readonly kind: "session-cwd";
  };
}

export interface WorkspaceRepository {
  readonly relativePath: string;
  readonly repository: ResourceRef;
}

export interface WorkspaceStatus {
  readonly repositories?: readonly WorkspaceRepository[];
  readonly openPullRequests?: number;
  readonly observedAt?: string;
}
