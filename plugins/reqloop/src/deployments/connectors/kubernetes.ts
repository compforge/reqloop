import { execFile } from "node:child_process";

import type { ReqloopConfigPaths } from "../../config.ts";
import {
  loadKubernetesConnectorConfigs,
  type KubernetesConnectorConfig,
} from "../config.ts";
import type {
  DeploymentObjectObservation,
  KubernetesConnector,
  KubernetesEnvironmentObservation,
  KubernetesEnvironmentTarget,
  KubernetesServiceDeployment,
  KubernetesServiceObservation,
  WorkloadObservation,
} from "../protocol.ts";

const KUBECTL_TIMEOUT_MS = 20_000;
const KUBECTL_REQUEST_TIMEOUT = "15s";
const KUBECTL_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

type JsonObject = Readonly<Record<string, unknown>>;

export type KubectlRunner = (args: readonly string[]) => Promise<unknown>;

function object(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function nestedObject(root: JsonObject, ...keys: string[]): JsonObject {
  let current = root;
  for (const key of keys) {
    current = object(current[key]) ?? {};
  }
  return current;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : undefined;
}

function numberValue(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : fallback;
}

function stringRecord(value: unknown): Readonly<Record<string, string>> {
  const source = object(value);
  if (!source) return {};
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(source)) {
    if (typeof item === "string") result[key] = item;
  }
  return result;
}

function items(payload: unknown): readonly JsonObject[] {
  const root = object(payload);
  if (!root) throw new Error("kubectl returned a non-object JSON payload");
  if (Array.isArray(root.items)) {
    return root.items.map((item, index) => {
      const parsed = object(item);
      if (!parsed) {
        throw new Error(`kubectl items[${index}] must be an object`);
      }
      return parsed;
    });
  }
  return [root];
}

function objectIdentity(resource: JsonObject): {
  readonly kind: string;
  readonly name: string;
  readonly namespace?: string;
  readonly resourceVersion?: string;
} {
  const metadata = nestedObject(resource, "metadata");
  const kind = stringValue(resource.kind);
  const name = stringValue(metadata.name);
  if (!kind || !name) {
    throw new Error("kubectl object must include kind and metadata.name");
  }
  return {
    kind,
    name,
    namespace: stringValue(metadata.namespace),
    resourceVersion: stringValue(metadata.resourceVersion),
  };
}

function deploymentRevision(resource: JsonObject): string | undefined {
  const metadata = nestedObject(resource, "metadata");
  const templateMetadata = nestedObject(resource, "spec", "template", "metadata");
  const candidates = [
    stringRecord(templateMetadata.annotations)["reqloop.compforge.dev/revision"],
    stringRecord(templateMetadata.labels)["app.kubernetes.io/version"],
    stringRecord(metadata.annotations)["reqloop.compforge.dev/revision"],
    stringRecord(metadata.labels)["app.kubernetes.io/version"],
  ];
  for (const candidate of candidates) {
    if (candidate?.trim()) return candidate.trim();
  }
  const containers = nestedObject(resource, "spec", "template", "spec")
    .containers;
  if (!Array.isArray(containers)) return undefined;
  const images = containers.flatMap((container) => {
    const image = stringValue(object(container)?.image);
    return image ? [image] : [];
  }).sort();
  return images.length > 0 ? images.join(",") : undefined;
}

function deploymentImages(resource: JsonObject): readonly string[] {
  const containers = nestedObject(resource, "spec", "template", "spec")
    .containers;
  if (!Array.isArray(containers)) return [];
  return Object.freeze(containers.flatMap((container) => {
    const image = stringValue(object(container)?.image);
    return image ? [image] : [];
  }));
}

function workloadObservation(resource: JsonObject): WorkloadObservation {
  const identity = objectIdentity(resource);
  const metadata = nestedObject(resource, "metadata");
  const spec = nestedObject(resource, "spec");
  const status = nestedObject(resource, "status");
  const desired = numberValue(spec.replicas, 1);
  const ready = numberValue(status.readyReplicas);
  const updated = numberValue(status.updatedReplicas);
  const available = numberValue(status.availableReplicas);
  const generation = numberValue(metadata.generation);
  const observedGeneration = numberValue(status.observedGeneration);
  const conditions = Array.isArray(status.conditions)
    ? status.conditions.flatMap((condition) => {
      const parsed = object(condition);
      return parsed ? [parsed] : [];
    })
    : [];
  const degraded = conditions.some((condition) =>
    (condition.type === "ReplicaFailure" && condition.status === "True") ||
    (condition.type === "Progressing" && condition.status === "False")
  );
  const converged = observedGeneration >= generation &&
    ready >= desired && updated >= desired && available >= desired;
  return Object.freeze({
    kind: identity.kind,
    namespace: identity.namespace ?? "default",
    name: identity.name,
    desired,
    ready,
    phase: degraded ? "degraded" : converged ? "ready" : "progressing",
  });
}

function servicePhase(
  workloads: readonly WorkloadObservation[],
): KubernetesServiceObservation["phase"] {
  if (workloads.some(({ phase }) => phase === "degraded")) return "degraded";
  if (workloads.every(({ phase }) => phase === "ready")) return "ready";
  return "progressing";
}

function defaultKubectlRunner(args: readonly string[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile(
      "kubectl",
      [...args],
      {
        encoding: "utf8",
        timeout: KUBECTL_TIMEOUT_MS,
        maxBuffer: KUBECTL_MAX_OUTPUT_BYTES,
      },
      (error, stdout, stderr) => {
        if (error) {
          if ("code" in error && error.code === "ENOENT") {
            reject(new Error("kubectl is not installed or is not on PATH"));
            return;
          }
          reject(new Error(
            `kubectl failed: ${stderr.trim() || error.message}`,
          ));
          return;
        }
        try {
          resolve(JSON.parse(stdout) as unknown);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          reject(new Error(`kubectl returned invalid JSON: ${detail}`));
        }
      },
    );
  });
}

export class KubectlKubernetesConnector implements KubernetesConnector {
  readonly source: string;
  private readonly context?: string;
  private readonly kubeconfig: string;

  constructor(
    config: KubernetesConnectorConfig,
    private readonly run: KubectlRunner = defaultKubectlRunner,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.source = config.source;
    this.context = config.context;
    this.kubeconfig = config.kubeconfig;
  }

  async observeEnvironment(
    target: KubernetesEnvironmentTarget,
  ): Promise<KubernetesEnvironmentObservation> {
    this.assertSource(target);
    const payload = object(await this.run([
      ...this.globalArgs(),
      "version",
      "--output=json",
    ]));
    if (!payload) throw new Error("kubectl version returned a non-object payload");
    const version = stringValue(nestedObject(payload, "serverVersion").gitVersion);
    return Object.freeze({
      observedAt: this.now().toISOString(),
      ...(version ? { version } : {}),
    });
  }

  async observeService(
    target: KubernetesEnvironmentTarget,
    deployment: KubernetesServiceDeployment,
  ): Promise<KubernetesServiceObservation> {
    this.assertSource(target);
    const references = [
      ...deployment.deployments.map((name) => `deployment/${name}`),
      ...(deployment.services ?? []).map((name) => `service/${name}`),
      ...(deployment.configMaps ?? []).map((name) => `configmap/${name}`),
    ];
    const observed = items(await this.run([
      ...this.globalArgs(),
      "get",
      ...references,
      "--namespace",
      deployment.namespace,
      "--output=json",
    ]));
    const deployments = observed.filter(({ kind }) => kind === "Deployment");
    const observedDeploymentNames = new Set(
      deployments.map((resource) => objectIdentity(resource).name),
    );
    for (const name of deployment.deployments) {
      if (!observedDeploymentNames.has(name)) {
        throw new Error(`kubectl result omitted Deployment ${name}`);
      }
    }
    const workloads = Object.freeze(deployments.map(workloadObservation));
    const artifacts = Object.freeze([
      ...new Set(deployments.flatMap(deploymentImages)),
    ].sort());
    const revisions = deployments.flatMap((resource) => {
      const revision = deploymentRevision(resource);
      if (!revision) return [];
      return [{ name: objectIdentity(resource).name, revision }];
    }).sort((left, right) => left.name.localeCompare(right.name));
    const deployedRevision = revisions.length === 1
      ? revisions[0]!.revision
      : revisions.length > 1
      ? revisions.map(({ name, revision }) => `${name}=${revision}`).join(";")
      : undefined;
    const objects: DeploymentObjectObservation[] = observed.map((resource) => {
      const identity = objectIdentity(resource);
      return Object.freeze({
        kind: identity.kind,
        namespace: identity.namespace ?? deployment.namespace,
        name: identity.name,
        ...(identity.resourceVersion
          ? { resourceVersion: identity.resourceVersion }
          : {}),
      });
    });
    return Object.freeze({
      phase: servicePhase(workloads),
      deployedRevision: deployedRevision ?? null,
      artifacts,
      workloads,
      objects: Object.freeze(objects),
      observedAt: this.now().toISOString(),
    });
  }

  private globalArgs(): readonly string[] {
    return Object.freeze([
      "--kubeconfig",
      this.kubeconfig,
      ...(this.context ? ["--context", this.context] : []),
      `--request-timeout=${KUBECTL_REQUEST_TIMEOUT}`,
    ]);
  }

  private assertSource(target: KubernetesEnvironmentTarget): void {
    if (target.source !== this.source) {
      throw new Error(
        `Kubernetes target source ${target.source} does not match Connector ${this.source}`,
      );
    }
  }
}

export function createKubernetesConnectors(
  paths: ReqloopConfigPaths,
  options: {
    readonly run?: KubectlRunner;
    readonly now?: () => Date;
  } = {},
): readonly KubernetesConnector[] {
  return Object.freeze(loadKubernetesConnectorConfigs(paths).map((config) =>
    new KubectlKubernetesConnector(config, options.run, options.now)
  ));
}
