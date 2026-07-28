import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";

import type { RepositoryIdentity } from "./protocol.ts";

function gitOutput(
  cwd: string,
  args: readonly string[],
): string | undefined {
  const result = spawnSync(
    "git",
    args,
    {
      cwd,
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  if (result.error || result.status !== 0) return;
  const output = result.stdout?.toString().trim();
  return output || undefined;
}

export function isRepositoryRoot(cwd: string): boolean {
  const topLevel = gitOutput(cwd, ["rev-parse", "--show-toplevel"]);
  if (!topLevel) return false;
  try {
    return realpathSync(cwd) === realpathSync(topLevel);
  } catch {
    return false;
  }
}

export function currentRepositoryIdentity(
  cwd: string,
): RepositoryIdentity | undefined {
  const remote = gitOutput(cwd, ["remote", "get-url", "origin"]);
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
