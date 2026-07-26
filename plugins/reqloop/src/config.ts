import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const REQLOOP_CONFIG_PATH = join(
  homedir(),
  ".baton",
  "plugins",
  "reqloop.json",
);

export type JsonObject = Readonly<Record<string, unknown>>;

export function jsonObject(name: string, value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be a JSON object`);
  }
  return value as JsonObject;
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error &&
    "code" in error &&
    error.code === "ENOENT";
}

/** Reads the temporary standalone config shared by reqloop Connectors. */
export function loadReqloopConfig(
  path: string = REQLOOP_CONFIG_PATH,
): JsonObject | undefined {
  let root: unknown;
  try {
    root = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`could not read reqloop config ${path}: ${detail}`);
  }
  const config = jsonObject("reqloop config", root);
  if (config.version !== 1) {
    throw new Error("reqloop config version must be 1");
  }
  return config;
}
