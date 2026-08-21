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
  ProductSpec,
  ServiceSpec,
} from "./protocol.ts";
import {
  componentResourceName,
  environmentResourceName,
  normalizeComponentSpec,
  normalizeEnvironmentSpec,
  normalizeProductSpec,
  normalizeServiceSpec,
  productResourceName,
  serviceResourceName,
} from "./resource.ts";
import type { RepositoryIdentity } from "../repositories/protocol.ts";

export interface KubernetesConnectorConfig {
  readonly source: string;
  readonly kubeconfig: string;
  readonly context?: string;
}

export interface DeploymentCatalog {
  readonly products: readonly ProductSpec[];
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

function componentRepository(
  componentName: string,
  value: unknown,
): RepositoryIdentity | undefined {
  if (value === undefined) return undefined;
  const identity = jsonObject(
    `reqloop component ${componentName} repository`,
    value,
  );
  return Object.freeze({
    forge: requiredString(
      `reqloop component ${componentName} repository forge`,
      identity.forge,
    ),
    path: requiredString(
      `reqloop component ${componentName} repository path`,
      identity.path,
    ),
  });
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

/** Reads the global Product deployment catalog. */
export function loadDeploymentCatalog(
  paths: ReqloopConfigPaths,
): DeploymentCatalog {
  const root = loadReqloopConfig(paths);
  const products: ProductSpec[] = [];
  const components: ComponentSpec[] = [];
  const environments: EnvironmentSpec[] = [];
  const services: ServiceSpec[] = [];
  const serviceNames = new Set<string>();
  for (const [rawProductName, rawProduct] of Object.entries(
    configMap(root, "products"),
  )) {
    const productName = requiredString("reqloop product name", rawProductName);
    const product = jsonObject(`reqloop product ${productName}`, rawProduct);
    products.push(normalizeProductSpec({
      identity: { name: productName },
      displayName: optionalString(
        `reqloop product ${productName} displayName`,
        product.displayName,
      ),
      description: optionalString(
        `reqloop product ${productName} description`,
        product.description,
      ),
    }));

    const componentsByKey = new Map<string, ComponentSpec>();
    for (const [rawName, rawComponent] of Object.entries(
      configMap(product, "components"),
    )) {
      const name = requiredString("reqloop component name", rawName);
      const qualifiedName = `${productName}/${name}`;
      const component = jsonObject(
        `reqloop component ${qualifiedName}`,
        rawComponent,
      );
      const spec = normalizeComponentSpec({
        identity: { product: productName, name },
        repository: componentRepository(
          qualifiedName,
          component.repository,
        ),
        displayName: optionalString(
          `reqloop component ${qualifiedName} displayName`,
          component.displayName,
        ),
        description: optionalString(
          `reqloop component ${qualifiedName} description`,
          component.description,
        ),
      });
      componentsByKey.set(name, spec);
      components.push(spec);
    }

    const environmentsByKey = new Map<string, EnvironmentSpec>();
    for (const [rawName, rawEnvironment] of Object.entries(
      configMap(product, "environments"),
    )) {
      const name = requiredString("reqloop environment name", rawName);
      const qualifiedName = `${productName}/${name}`;
      const environment = jsonObject(
        `reqloop environment ${qualifiedName}`,
        rawEnvironment,
      );
      const spec = normalizeEnvironmentSpec({
        identity: { product: productName, name },
        displayName: optionalString(
          `reqloop environment ${qualifiedName} displayName`,
          environment.displayName,
        ),
        description: optionalString(
          `reqloop environment ${qualifiedName} description`,
          environment.description,
        ),
        targets: environmentTargets(qualifiedName, environment.targets),
      });
      environmentsByKey.set(name, spec);
      environments.push(spec);
    }

    for (const [rawKey, rawService] of Object.entries(
      configMap(product, "services"),
    )) {
      const key = requiredString("reqloop service key", rawKey);
      const qualifiedKey = `${productName}/${key}`;
      const service = jsonObject(`reqloop service ${qualifiedKey}`, rawService);
      const componentKey = requiredString(
        `reqloop service ${qualifiedKey} component`,
        service.component,
      );
      const environmentKey = requiredString(
        `reqloop service ${qualifiedKey} environment`,
        service.environment,
      );
      const component = componentsByKey.get(componentKey);
      if (!component) {
        throw new Error(
          `reqloop service ${qualifiedKey} references unknown Component: ${componentKey}`,
        );
      }
      const environment = environmentsByKey.get(environmentKey);
      if (!environment) {
        throw new Error(
          `reqloop service ${qualifiedKey} references unknown Environment: ${environmentKey}`,
        );
      }
      const deployment = jsonObject(
        `reqloop service ${qualifiedKey} deployment`,
        service.deployment,
      );
      if (deployment.kind !== "kubernetes") {
        throw new Error(
          `reqloop service ${qualifiedKey} deployment kind must be "kubernetes"`,
        );
      }
      const kubernetes: KubernetesServiceDeployment = {
        kind: "kubernetes",
        target: requiredString(
          `reqloop service ${qualifiedKey} Kubernetes target`,
          deployment.target,
        ),
        namespace: requiredString(
          `reqloop service ${qualifiedKey} Kubernetes namespace`,
          deployment.namespace,
        ),
        deployments: strings(
          `reqloop service ${qualifiedKey} Kubernetes deployments`,
          deployment.deployments,
        ),
        services: optionalStrings(
          `reqloop service ${qualifiedKey} Kubernetes services`,
          deployment.services,
        ),
        configMaps: optionalStrings(
          `reqloop service ${qualifiedKey} Kubernetes configMaps`,
          deployment.configMaps,
        ),
      };
      if (!environment.targets.some(({ name, kind }) =>
        kind === "kubernetes" && name === kubernetes.target
      )) {
        throw new Error(
          `reqloop service ${qualifiedKey} references unknown Kubernetes target: ${kubernetes.target}`,
        );
      }
      const spec = normalizeServiceSpec({
        component: component.identity,
        environment: environment.identity,
        deployment: kubernetes,
        url: optionalString(
          `reqloop service ${qualifiedKey} url`,
          service.url,
        ),
      });
      const name = serviceResourceName(spec);
      if (serviceNames.has(name)) {
        throw new Error(
          `duplicate Service for ${productName}/${componentKey} in ${productName}/${environmentKey}`,
        );
      }
      serviceNames.add(name);
      services.push(spec);
    }
  }

  return Object.freeze({
    products: Object.freeze(products),
    components: Object.freeze(components),
    environments: Object.freeze(environments),
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
  readonly products: readonly Source<ProductSpec>[];
  readonly components: readonly Source<ComponentSpec>[];
  readonly environments: readonly Source<EnvironmentSpec>[];
  readonly services: readonly Source<ServiceSpec>[];
} {
  return Object.freeze({
    products: [new CatalogSource(
      "deployment-catalog-products",
      catalog.products.map((spec) => ({
        name: productResourceName(spec.identity),
        spec,
      })),
    )],
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
