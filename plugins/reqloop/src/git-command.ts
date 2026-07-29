const DEFAULT_TIMEOUT_MS = 2_000;
const MAX_OUTPUT_BYTES = 64 * 1024;

/**
 * Runs a read-only Git query without blocking Baton's event loop.
 *
 * Git output is intentionally bounded because these calls run while Sources and
 * Context providers are serving the host.
 */
export async function gitOutput(
  cwd: string,
  args: readonly string[],
  options: { readonly timeoutMs?: number } = {},
): Promise<string | undefined> {
  let child: Bun.Subprocess<"ignore", "pipe", "ignore">;
  try {
    child = Bun.spawn(["git", ...args], {
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      killSignal: "SIGKILL",
      maxBuffer: MAX_OUTPUT_BYTES,
    });
  } catch {
    return;
  }

  try {
    const stdoutPromise = new Response(child.stdout).text();
    const [exitCode, stdout] = await Promise.all([
      child.exited,
      stdoutPromise,
    ]);
    if (exitCode !== 0) return;
    return stdout.trim() || undefined;
  } catch {
    return;
  }
}
