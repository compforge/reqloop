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
  readonly source: string;
  readonly provider: "github" | "gitlab";
  readonly host: string;
  readonly apiHost?: string;
  readonly uid?: string;
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

  return Object.entries(forges).map(([rawHost, rawForge]) => {
    const host = requiredString("reqloop forge host", rawHost);
    const forge = jsonObject(`reqloop forge ${host}`, rawForge);
    const configuredProvider = provider(
      `reqloop forge ${host} type`,
      forge.type,
      host,
    );
    const configuredToken = optionalString(
      `reqloop forge ${host} token`,
      forge.token,
    );
    const apiHost = optionalString(
      `reqloop forge ${host} api_host`,
      forge.api_host,
    );
    const uid = optionalString(
      `reqloop forge ${host} uid`,
      forge.uid,
    );
    const token =
      environmentToken(configuredProvider, environment) ?? configuredToken;
    return Object.freeze({
      source: host,
      provider: configuredProvider,
      host,
      ...(apiHost ? { apiHost } : {}),
      ...(uid ? { uid } : {}),
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
