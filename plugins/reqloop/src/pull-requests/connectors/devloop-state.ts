import { dirname, join, resolve } from "node:path";

function gitOutput(
  cwd: string,
  args: readonly string[],
): string | undefined {
  let result: ReturnType<typeof Bun.spawnSync>;
  try {
    result = Bun.spawnSync(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 2_000,
    });
  } catch {
    return;
  }
  if (result.exitCode !== 0) return;
  const output = result.stdout?.toString().trim();
  return output || undefined;
}

export function devloopStatePath(
  cwd: string,
  fileName: string,
): string | undefined {
  const commonDir = gitOutput(cwd, ["rev-parse", "--git-common-dir"]);
  if (!commonDir) return;
  return join(dirname(resolve(cwd, commonDir)), ".devloop", fileName);
}
