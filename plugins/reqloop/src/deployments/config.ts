import { isAbsolute } from "node:path";

import type {
  Source,
  SourceContext,
} from "@compforge/baton-plugin";

import {
  jsonObject,
  loadReqloopConfig,
  type ReqloopConfigPaths,
} from "../config.ts";
import type {
  ComponentSpec,
  EnvironmentSpec,
  EnvironmentTarget,
  KubernetesServiceDeployment,
  ServiceSpec,
} from "./protocol.ts";
import {
  componentResourceName,
  environmentResourceName,
  normalizeComponentSpec,
  normalizeEnvironmentSpec,
  normalizeServiceSpec,
  serviceResourceName,
} from "./resource.ts";

export interface KubernetesConnectorConfig {
  readonly source: string;
  readonly kubeconfig: string;
  readonly context?: string;
}

export interface DeploymentCatalog {
  readonly components: readonly ComponentSpec[];
  readonly environments: readonly EnvironmentSpec[];
  readonly services: readonly ServiceSpec[];
}

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

function strings(
  name: string,
  value: unknown,
): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${name} must be a non-empty string array`);
  }
  return Object.freeze(value.map((item, index) =>
    requiredString(`${name}[${index}]`, item)
  ));
}

function optionalStrings(
  name: string,
  value: unknown,
): readonly string[] | undefined {
  return value === undefined ? undefined : strings(name, value);
}

function configMap(
  root: Readonly<Record<string, unknown>> | undefined,
  key: string,
): Readonly<Record<string, unknown>> {
  const value = root?.[key];
  return value === undefined ? {} : jsonObject(`reqloop config ${key}`, value);
}

function environmentTargets(
  environmentName: string,
  value: unknown,
): readonly EnvironmentTarget[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(
      `reqloop environment ${environmentName} targets must be an array`,
    );
  }
  return Object.freeze(value.map((rawTarget, index) => {
    const target = jsonObject(
      `reqloop environment ${environmentName} targets[${index}]`,
      rawTarget,
    );
    if (target.kind !== "kubernetes") {
      throw new Error(
        `reqloop environment ${environmentName} target kind must be "kubernetes"`,
      );
    }
    return Object.freeze({
      kind: "kubernetes" as const,
      name: requiredString(
        `reqloop environment ${environmentName} target name`,
        target.name,
      ),
      source: requiredString(
        `reqloop environment ${environmentName} Kubernetes source`,
        target.source,
      ),
      cluster: requiredString(
        `reqloop environment ${environmentName} Kubernetes cluster`,
        target.cluster,
      ),
    });
  }));
}

/** Reads the global Component, Environment, and Service catalog. */
export function loadDeploymentCatalog(
  paths: ReqloopConfigPaths,
): DeploymentCatalog {
  const root = loadReqloopConfig(paths);
  const componentsByKey = new Map<string, ComponentSpec>();
  for (const [rawName, rawComponent] of Object.entries(
    configMap(root, "components"),
  )) {
    const name = requiredString("reqloop component name", rawName);
    const component = jsonObject(`reqloop component ${name}`, rawComponent);
    const spec = normalizeComponentSpec({
      identity: {
        product: requiredString(
          `reqloop component ${name} product`,
          component.product,
        ),
        name,
      },
      displayName: optionalString(
        `reqloop component ${name} displayName`,
        component.displayName,
      ),
      description: optionalString(
        `reqloop component ${name} description`,
        component.description,
      ),
    });
    componentsByKey.set(name, spec);
  }

  const environmentsByKey = new Map<string, EnvironmentSpec>();
  for (const [rawName, rawEnvironment] of Object.entries(
    configMap(root, "environments"),
  )) {
    const name = requiredString("reqloop environment name", rawName);
    const environment = jsonObject(
      `reqloop environment ${name}`,
      rawEnvironment,
    );
    const spec = normalizeEnvironmentSpec({
      identity: { name },
      displayName: optionalString(
        `reqloop environment ${name} displayName`,
        environment.displayName,
      ),
      description: optionalString(
        `reqloop environment ${name} description`,
        environment.description,
      ),
      targets: environmentTargets(name, environment.targets),
    });
    environmentsByKey.set(name, spec);
  }

  const services: ServiceSpec[] = [];
  const serviceNames = new Set<string>();
  for (const [rawKey, rawService] of Object.entries(
    configMap(root, "services"),
  )) {
    const key = requiredString("reqloop service key", rawKey);
    const service = jsonObject(`reqloop service ${key}`, rawService);
    const componentKey = requiredString(
      `reqloop service ${key} component`,
      service.component,
    );
    const environmentKey = requiredString(
      `reqloop service ${key} environment`,
      service.environment,
    );
    const component = componentsByKey.get(componentKey);
    if (!component) {
      throw new Error(
        `reqloop service ${key} references unknown Component: ${componentKey}`,
      );
    }
    const environment = environmentsByKey.get(environmentKey);
    if (!environment) {
      throw new Error(
        `reqloop service ${key} references unknown Environment: ${environmentKey}`,
      );
    }
    const deployment = jsonObject(
      `reqloop service ${key} deployment`,
      service.deployment,
    );
    if (deployment.kind !== "kubernetes") {
      throw new Error(
        `reqloop service ${key} deployment kind must be "kubernetes"`,
      );
    }
    const kubernetes: KubernetesServiceDeployment = {
      kind: "kubernetes",
      target: requiredString(
        `reqloop service ${key} Kubernetes target`,
        deployment.target,
      ),
      namespace: requiredString(
        `reqloop service ${key} Kubernetes namespace`,
        deployment.namespace,
      ),
      deployments: strings(
        `reqloop service ${key} Kubernetes deployments`,
        deployment.deployments,
      ),
      services: optionalStrings(
        `reqloop service ${key} Kubernetes services`,
        deployment.services,
      ),
      configMaps: optionalStrings(
        `reqloop service ${key} Kubernetes configMaps`,
        deployment.configMaps,
      ),
    };
    if (!environment.targets.some(({ name, kind }) =>
      kind === "kubernetes" && name === kubernetes.target
    )) {
      throw new Error(
        `reqloop service ${key} references unknown Kubernetes target: ${kubernetes.target}`,
      );
    }
    const spec = normalizeServiceSpec({
      component: component.identity,
      environment: environment.identity,
      deployment: kubernetes,
      url: optionalString(`reqloop service ${key} url`, service.url),
    });
    const name = serviceResourceName(spec);
    if (serviceNames.has(name)) {
      throw new Error(
        `duplicate Service for ${componentKey} in ${environmentKey}`,
      );
    }
    serviceNames.add(name);
    services.push(spec);
  }

  return Object.freeze({
    components: Object.freeze([...componentsByKey.values()]),
    environments: Object.freeze([...environmentsByKey.values()]),
    services: Object.freeze(services),
  });
}

/** Reads Kubernetes access configuration; credentials remain kubeconfig-owned. */
export function loadKubernetesConnectorConfigs(
  paths: ReqloopConfigPaths,
): readonly KubernetesConnectorConfig[] {
  const root = loadReqloopConfig(paths);
  return Object.freeze(Object.entries(configMap(root, "kubernetes")).map(
    ([rawSource, rawConnector]) => {
      const source = requiredString("reqloop Kubernetes source", rawSource);
      const connector = jsonObject(
        `reqloop Kubernetes source ${source}`,
        rawConnector,
      );
      const kubeconfig = requiredString(
        `reqloop Kubernetes source ${source} kubeconfig`,
        connector.kubeconfig,
      );
      if (!isAbsolute(kubeconfig)) {
        throw new Error(
          `reqloop Kubernetes source ${source} kubeconfig must be an absolute path`,
        );
      }
      const context = optionalString(
        `reqloop Kubernetes source ${source} context`,
        connector.context,
      );
      return Object.freeze({
        source,
        kubeconfig,
        ...(context ? { context } : {}),
      });
    },
  ));
}

class CatalogSource<TSpec> implements Source<TSpec> {
  readonly type = "resource";

  constructor(
    readonly sourceId: string,
    private readonly entries: readonly {
      readonly name: string;
      readonly spec: TSpec;
    }[],
  ) {}

  async start(context: SourceContext<TSpec>): Promise<void> {
    for (const entry of this.entries) {
      if (context.signal.aborted) return;
      await context.emit({ ...entry, namespace: "v1" });
    }
  }
}

export function deploymentCatalogSources(catalog: DeploymentCatalog): {
  readonly components: readonly Source<ComponentSpec>[];
  readonly environments: readonly Source<EnvironmentSpec>[];
  readonly services: readonly Source<ServiceSpec>[];
} {
  return Object.freeze({
    components: [new CatalogSource(
      "deployment-catalog-components",
      catalog.components.map((spec) => ({
        name: componentResourceName(spec.identity),
        spec,
      })),
    )],
    environments: [new CatalogSource(
      "deployment-catalog-environments",
      catalog.environments.map((spec) => ({
        name: environmentResourceName(spec.identity),
        spec,
      })),
    )],
    services: [new CatalogSource(
      "deployment-catalog-services",
      catalog.services.map((spec) => ({
        name: serviceResourceName(spec),
        spec,
      })),
    )],
  });
}
