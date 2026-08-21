import { createHash } from "node:crypto";

import type {
  ComponentIdentity,
  ComponentSpec,
  EnvironmentIdentity,
  EnvironmentSpec,
  KubernetesServiceDeployment,
  ServiceSpec,
} from "./protocol.ts";

export const COMPONENT_RESOURCE_TYPE = Object.freeze({
  apiVersion: "reqloop.baton.dev/v1alpha1",
  kind: "Component",
  shortNames: ["component"],
} as const);

export const ENVIRONMENT_RESOURCE_TYPE = Object.freeze({
  apiVersion: "reqloop.baton.dev/v1alpha1",
  kind: "Environment",
  shortNames: ["env"],
} as const);

export const SERVICE_RESOURCE_TYPE = Object.freeze({
  apiVersion: "reqloop.baton.dev/v1alpha1",
  kind: "Service",
  shortNames: ["svc"],
} as const);

function required(name: string, value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${name} must not be empty`);
  return normalized;
}

function resourceName(prefix: string, identity: unknown): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(identity))
    .digest("hex")
    .slice(0, 24);
  return `${prefix}-${digest}`;
}

export function normalizeComponentIdentity(
  identity: ComponentIdentity,
): ComponentIdentity {
  return Object.freeze({
    product: required("Component product", identity.product),
    name: required("Component name", identity.name),
  });
}

export function componentResourceName(identity: ComponentIdentity): string {
  const normalized = normalizeComponentIdentity(identity);
  return resourceName("component", [normalized.product, normalized.name]);
}

export function normalizeEnvironmentIdentity(
  identity: EnvironmentIdentity,
): EnvironmentIdentity {
  return Object.freeze({
    name: required("Environment name", identity.name),
  });
}

export function environmentResourceName(
  identity: EnvironmentIdentity,
): string {
  return resourceName(
    "environment",
    [normalizeEnvironmentIdentity(identity).name],
  );
}

function normalizeKubernetesDeployment(
  deployment: KubernetesServiceDeployment,
): KubernetesServiceDeployment {
  if (deployment.deployments.length === 0) {
    throw new Error("Service Kubernetes deployments must not be empty");
  }
  return Object.freeze({
    kind: "kubernetes",
    target: required("Service Kubernetes target", deployment.target),
    namespace: required(
      "Service Kubernetes namespace",
      deployment.namespace,
    ),
    deployments: Object.freeze(deployment.deployments.map((name) =>
      required("Service Kubernetes Deployment", name)
    )),
    ...(deployment.services
      ? {
        services: Object.freeze(deployment.services.map((name) =>
          required("Service Kubernetes Service", name)
        )),
      }
      : {}),
    ...(deployment.configMaps
      ? {
        configMaps: Object.freeze(deployment.configMaps.map((name) =>
          required("Service Kubernetes ConfigMap", name)
        )),
      }
      : {}),
  });
}

export function normalizeComponentSpec(spec: ComponentSpec): ComponentSpec {
  return Object.freeze({
    identity: normalizeComponentIdentity(spec.identity),
    ...(spec.displayName
      ? { displayName: required("Component displayName", spec.displayName) }
      : {}),
    ...(spec.description
      ? { description: required("Component description", spec.description) }
      : {}),
  });
}

export function normalizeEnvironmentSpec(
  spec: EnvironmentSpec,
): EnvironmentSpec {
  const targetNames = new Set<string>();
  const targets = spec.targets.map((target) => {
    const name = required("Environment target name", target.name);
    if (targetNames.has(name)) {
      throw new Error(`duplicate Environment target: ${name}`);
    }
    targetNames.add(name);
    return Object.freeze({
      kind: "kubernetes" as const,
      name,
      source: required("Environment Kubernetes source", target.source),
      cluster: required("Environment Kubernetes cluster", target.cluster),
    });
  });
  return Object.freeze({
    identity: normalizeEnvironmentIdentity(spec.identity),
    ...(spec.displayName
      ? { displayName: required("Environment displayName", spec.displayName) }
      : {}),
    ...(spec.description
      ? { description: required("Environment description", spec.description) }
      : {}),
    targets: Object.freeze(targets),
  });
}

export function normalizeServiceSpec(spec: ServiceSpec): ServiceSpec {
  return Object.freeze({
    component: normalizeComponentIdentity(spec.component),
    environment: normalizeEnvironmentIdentity(spec.environment),
    deployment: normalizeKubernetesDeployment(spec.deployment),
    ...(spec.url ? { url: required("Service url", spec.url) } : {}),
  });
}

export function serviceResourceName(spec: ServiceSpec): string {
  const normalized = normalizeServiceSpec(spec);
  return resourceName("service", [
    normalized.component.product,
    normalized.component.name,
    normalized.environment.name,
  ]);
}
