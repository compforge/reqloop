import {
  jsonObject,
  loadReqloopConfig,
  type ReqloopConfigPaths,
} from "../../config.ts";
import type { Fetch } from "./http.ts";
import { GitHubForgeConnector } from "./github.ts";
import { GitLabForgeConnector } from "./gitlab.ts";
import type { ForgeConnector } from "../protocol.ts";

export interface ForgeConfig {
  readonly forge: string;
  readonly provider: "github" | "gitlab";
  /** Network host used by the provider adapter. */
  readonly host: string;
  readonly uids?: readonly string[];
  readonly token?: string;
}

type Environment = Readonly<Record<string, string | undefined>>;

function requiredString(name: string, value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must not be empty`);
  }
  return value.trim();
}

function optionalString(name: string, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(name, value);
}

function optionalStrings(
  name: string,
  value: unknown,
): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${name} must be a non-empty string array`);
  }
  return Object.freeze(
    value.map((item, index) => requiredString(`${name}[${index}]`, item)),
  );
}

function inferredProvider(host: string): "github" | "gitlab" {
  return host === "github.com" || host.startsWith("github.")
    ? "github"
    : "gitlab";
}

function provider(
  name: string,
  value: unknown,
  host: string,
): "github" | "gitlab" {
  if (value === undefined) return inferredProvider(host);
  if (value !== "github" && value !== "gitlab") {
    throw new Error(`${name} must be "github" or "gitlab"`);
  }
  return value;
}

function environmentToken(
  forge: "github" | "gitlab",
  environment: Environment,
): string | undefined {
  const candidates = forge === "github"
    ? [environment.GITHUB_TOKEN, environment.GH_TOKEN]
    : [environment.GITLAB_TOKEN];
  for (const token of candidates) {
    if (token?.trim()) return token.trim();
  }
  return undefined;
}

/** Parses the devloop-compatible host-keyed `forges` registry. */
export function loadForgeConfigs(
  paths: ReqloopConfigPaths,
  environment: Environment = process.env,
): readonly ForgeConfig[] {
  const config = loadReqloopConfig(paths);
  if (!config) return [];
  const forges = config.forges === undefined
    ? {}
    : jsonObject("reqloop config forges", config.forges);

  return Object.entries(forges).map(([rawForge, rawConfig]) => {
    const forge = requiredString("reqloop forge identity", rawForge);
    const config = jsonObject(`reqloop forge ${forge}`, rawConfig);
    const host = optionalString(
      `reqloop forge ${forge} api_host`,
      config.api_host,
    ) ?? forge;
    const configuredProvider = provider(
      `reqloop forge ${forge} type`,
      config.type,
      host,
    );
    const configuredToken = optionalString(
      `reqloop forge ${forge} token`,
      config.token,
    );
    const uids = optionalStrings(
      `reqloop forge ${forge} uids`,
      config.uids,
    );
    const token =
      environmentToken(configuredProvider, environment) ?? configuredToken;
    return Object.freeze({
      forge,
      provider: configuredProvider,
      host,
      ...(uids ? { uids } : {}),
      ...(token ? { token } : {}),
    });
  });
}

export function createForgeConnectors(
  paths: ReqloopConfigPaths,
  options: {
    readonly environment?: Environment;
    readonly fetch?: Fetch;
  } = {},
): readonly ForgeConnector[] {
  const connectors: ForgeConnector[] = [];
  for (const config of loadForgeConfigs(paths, options.environment)) {
    if (!config.token) continue;
    connectors.push(
      config.provider === "github"
        ? new GitHubForgeConnector(config, options)
        : new GitLabForgeConnector(config, options),
    );
  }
  return connectors;
}
