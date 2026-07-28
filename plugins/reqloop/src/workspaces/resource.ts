import type { WorkspaceSpec } from "./protocol.ts";

export const WORKSPACE_RESOURCE_TYPE = Object.freeze({
  apiVersion: "reqloop.baton.dev/v1alpha1",
  kind: "Workspace",
} as const);

export const WORKSPACE_RESOURCE_NAME = "workspace";

export function workspaceSpec(): WorkspaceSpec {
  return {
    root: { kind: "session-cwd" },
  };
}
