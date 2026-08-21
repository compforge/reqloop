import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { PluginDataDirectories } from "@compforge/baton-plugin";

export const REQLOOP_CONFIG_FILE = "config.json";
export type JsonObject = Readonly<Record<string, unknown>>;
export type ReqloopConfigPaths = string | readonly string[];

/** Global-only config used by user-global Resource catalogs. */
export function reqloopGlobalConfigPath(
  dataDirs: Pick<PluginDataDirectories, "global">,
): string {
  return join(dataDirs.global, REQLOOP_CONFIG_FILE);
}

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

function mergeJsonObjects(
  broader: JsonObject,
  narrower: JsonObject,
): JsonObject {
  const merged: Record<string, unknown> = { ...broader };
  for (const [key, value] of Object.entries(narrower)) {
    const existing = merged[key];
    merged[key] =
      existing && typeof existing === "object" && !Array.isArray(existing) &&
        value && typeof value === "object" && !Array.isArray(value)
        ? mergeJsonObjects(
          existing as JsonObject,
          value as JsonObject,
        )
        : value;
  }
  return Object.freeze(merged);
}

/** Returns reqloop's configuration files from broadest to narrowest scope. */
export function reqloopConfigPaths(
  dataDirs: Pick<
    PluginDataDirectories,
    "global" | "project" | "session"
  >,
): readonly string[] {
  return Object.freeze([
    join(dataDirs.global, REQLOOP_CONFIG_FILE),
    join(dataDirs.project, REQLOOP_CONFIG_FILE),
    join(dataDirs.session, REQLOOP_CONFIG_FILE),
  ]);
}

/** Reads and overlays reqloop Connector configuration by scope order. */
export function loadReqloopConfig(
  paths: ReqloopConfigPaths,
): JsonObject | undefined {
  const orderedPaths = typeof paths === "string" ? [paths] : paths;
  let result: JsonObject | undefined;
  for (const path of orderedPaths) {
    let root: unknown;
    try {
      root = JSON.parse(readFileSync(path, "utf8")) as unknown;
    } catch (error) {
      if (isMissingFile(error)) continue;
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`could not read reqloop config ${path}: ${detail}`);
    }
    const config = jsonObject(`reqloop config ${path}`, root);
    if (config.version !== 2) {
      throw new Error(`reqloop config version must be 2: ${path}`);
    }
    result = result ? mergeJsonObjects(result, config) : config;
  }
  return result;
}
