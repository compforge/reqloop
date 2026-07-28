import { spawnSync } from "node:child_process";

import type { RepositoryIdentity } from "./protocol.ts";

export function currentRepositoryIdentity(
  cwd: string,
): RepositoryIdentity | undefined {
  const result = spawnSync(
    "git",
    ["remote", "get-url", "origin"],
    {
      cwd,
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  if (result.error || result.status !== 0) return;
  const remote = result.stdout?.toString().trim();
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
