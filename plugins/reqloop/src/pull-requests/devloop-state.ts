import {
  existsSync,
  readFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import { gitOutput } from "../git-command.ts";

export async function devloopStatePath(
  cwd: string,
  fileName: string,
): Promise<string | undefined> {
  const commonDir = await gitOutput(cwd, ["rev-parse", "--git-common-dir"]);
  if (!commonDir) return;
  return join(dirname(resolve(cwd, commonDir)), ".devloop", fileName);
}

function openPullRequestNumber(value: unknown): number | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const pullRequest = value as Record<string, unknown>;
  if (
    pullRequest.state !== "open" ||
    !Number.isSafeInteger(pullRequest.number) ||
    (pullRequest.number as number) < 1
  ) {
    return;
  }
  return pullRequest.number as number;
}

export function readOpenPullRequestNumbers(
  path: string,
): readonly number[] {
  if (!existsSync(path)) return [];

  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (cause) {
    throw new Error(`Could not read devloop PR state: ${path}`, { cause });
  }

  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (cause) {
    throw new Error(`Could not parse devloop PR state: ${path}`, { cause });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Devloop PR state must be a JSON object: ${path}`);
  }
  const records = (value as Record<string, unknown>).prs;
  if (!Array.isArray(records)) {
    throw new Error(
      `Devloop PR state must contain a prs array: ${path}`,
    );
  }

  const numbers = new Set<number>();
  for (const record of records) {
    const number = openPullRequestNumber(record);
    if (number !== undefined) numbers.add(number);
  }
  return [...numbers].sort((left, right) => left - right);
}
