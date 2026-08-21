import { createHash } from "node:crypto";

import type {
  ComponentIdentity,
  ComponentSpec,
  EnvironmentIdentity,
  EnvironmentSpec,
  KubernetesServiceDeployment,
  ProductIdentity,
  ProductSpec,
  ServiceSpec,
} from "./protocol.ts";

export const PRODUCT_RESOURCE_TYPE = Object.freeze({
  apiVersion: "reqloop.baton.dev/v1alpha2",
  kind: "Product",
  shortNames: ["product"],
} as const);

export const COMPONENT_RESOURCE_TYPE = Object.freeze({
  apiVersion: "reqloop.baton.dev/v1alpha2",
  kind: "Component",
  shortNames: ["component"],
} as const);

export const ENVIRONMENT_RESOURCE_TYPE = Object.freeze({
  apiVersion: "reqloop.baton.dev/v1alpha2",
  kind: "Environment",
  shortNames: ["env"],
} as const);

export const SERVICE_RESOURCE_TYPE = Object.freeze({
  apiVersion: "reqloop.baton.dev/v1alpha2",
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

export function normalizeProductIdentity(
  identity: ProductIdentity,
): ProductIdentity {
  return Object.freeze({
    name: required("Product name", identity.name),
  });
}

export function productResourceName(identity: ProductIdentity): string {
  return resourceName("product", [normalizeProductIdentity(identity).name]);
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
    product: required("Environment product", identity.product),
    name: required("Environment name", identity.name),
  });
}

export function environmentResourceName(
  identity: EnvironmentIdentity,
): string {
  const normalized = normalizeEnvironmentIdentity(identity);
  return resourceName(
    "environment",
    [normalized.product, normalized.name],
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

export function normalizeProductSpec(spec: ProductSpec): ProductSpec {
  return Object.freeze({
    identity: normalizeProductIdentity(spec.identity),
    ...(spec.displayName
      ? { displayName: required("Product displayName", spec.displayName) }
      : {}),
    ...(spec.description
      ? { description: required("Product description", spec.description) }
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
  const component = normalizeComponentIdentity(spec.component);
  const environment = normalizeEnvironmentIdentity(spec.environment);
  if (component.product !== environment.product) {
    throw new Error(
      `Service Component and Environment must belong to the same Product: ${component.product} != ${environment.product}`,
    );
  }
  return Object.freeze({
    component,
    environment,
    deployment: normalizeKubernetesDeployment(spec.deployment),
    ...(spec.url ? { url: required("Service url", spec.url) } : {}),
  });
}

export function serviceResourceName(spec: ServiceSpec): string {
  const normalized = normalizeServiceSpec(spec);
  return resourceName("service", [
    normalized.component.product,
    normalized.component.name,
    normalized.environment.product,
    normalized.environment.name,
  ]);
}
