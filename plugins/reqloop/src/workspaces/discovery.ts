import {
  readdirSync,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";

import {
  currentRepositoryIdentity,
  isRepositoryRoot,
} from "../repositories/identity.ts";
import type {
  RepositoryIdentity,
} from "../repositories/protocol.ts";

export interface WorkspaceCandidate {
  readonly path: string;
  readonly relativePath: string;
}

export interface WorkspaceRepositoryCheckout extends WorkspaceCandidate {
  readonly identity: RepositoryIdentity;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Keeps discovery bounded while covering a single checkout and aggregation
 * directories whose direct children include repository symlinks.
 */
export function workspaceCandidates(root: string): readonly WorkspaceCandidate[] {
  const workspaceRoot = resolve(root);
  const candidates: WorkspaceCandidate[] = [{
    path: workspaceRoot,
    relativePath: ".",
  }];
  const entries = readdirSync(workspaceRoot, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const path = join(workspaceRoot, entry.name);
    if (!isDirectory(path)) continue;
    candidates.push({
      path,
      relativePath: entry.name,
    });
  }
  return candidates;
}

export function discoverWorkspaceRepositories(
  root: string,
): readonly WorkspaceRepositoryCheckout[] {
  const repositories: WorkspaceRepositoryCheckout[] = [];
  for (const candidate of workspaceCandidates(root)) {
    if (!isRepositoryRoot(candidate.path)) continue;
    const identity = currentRepositoryIdentity(candidate.path);
    if (identity) repositories.push({ ...candidate, identity });
  }
  return repositories;
}
