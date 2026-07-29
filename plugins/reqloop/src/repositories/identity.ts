import { realpathSync } from "node:fs";

import { gitOutput } from "../git-command.ts";
import type { RepositoryIdentity } from "./protocol.ts";

export async function isRepositoryRoot(cwd: string): Promise<boolean> {
  const topLevel = await gitOutput(
    cwd,
    ["rev-parse", "--show-toplevel"],
    { timeoutMs: 5_000 },
  );
  if (!topLevel) return false;
  try {
    return realpathSync(cwd) === realpathSync(topLevel);
  } catch {
    return false;
  }
}

export async function currentRepositoryIdentity(
  cwd: string,
): Promise<RepositoryIdentity | undefined> {
  const remote = await gitOutput(
    cwd,
    ["remote", "get-url", "origin"],
    { timeoutMs: 5_000 },
  );
  if (!remote) return;

  let source: string;
  let repository: string;
  if (!remote.includes("://")) {
    const match = remote.match(/^(?:[^@]+@)?([^:]+):(.+)$/);
    if (!match) return;
    source = match[1]!;
    repository = match[2]!;
  } else {
    let url: URL;
    try {
      url = new URL(remote);
    } catch {
      return;
    }
    source = url.hostname;
    repository = url.pathname.replace(/^\/+/, "");
  }
  repository = repository.replace(/\.git$/, "");
  if (!source || !repository) return;
  return Object.freeze({ source, repository });
}
