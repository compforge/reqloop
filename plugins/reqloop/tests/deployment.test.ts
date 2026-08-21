import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  Resource,
  ResourceClient,
  ResourceRef,
  ResourceType,
} from "@compforge/baton-plugin";

import {
  createEnvironmentController,
  createServiceController,
} from "../src/deployments/controller.ts";
import {
  deploymentCatalogSources,
  loadDeploymentCatalog,
  loadKubernetesConnectorConfigs,
} from "../src/deployments/config.ts";
import {
  KubectlKubernetesConnector,
} from "../src/deployments/connectors/kubernetes.ts";
import type {
  EnvironmentSpec,
  EnvironmentStatus,
  KubernetesConnector,
  ServiceSpec,
  ServiceStatus,
} from "../src/deployments/protocol.ts";
import {
  ENVIRONMENT_RESOURCE_TYPE,
  componentResourceName,
  environmentResourceName,
  normalizeServiceSpec,
  productResourceName,
  SERVICE_RESOURCE_TYPE,
  serviceResourceName,
} from "../src/deployments/resource.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function configFile(config: unknown): string {
  const root = mkdtempSync(join(tmpdir(), "reqloop-deployment-"));
  roots.push(root);
  const path = join(root, "config.json");
  writeFileSync(path, JSON.stringify(config));
  return path;
}

function sourceContext<TSpec>(emitted: unknown[]) {
  return {
    signal: new AbortController().signal,
    async emit(resource: {
      readonly name: string;
      readonly namespace?: "v1";
      readonly spec: TSpec;
    }) {
      emitted.push(resource);
    },
    reportError(error: unknown) {
      throw error;
    },
  };
}

function resource<TSpec, TStatus>(
  type: ResourceType,
  name: string,
  spec: TSpec,
  status: TStatus,
): Readonly<Resource<TSpec, TStatus>> {
  return {
    ...type,
    metadata: {
      name,
      namespace: "v1",
      uid: `uid-${name}`,
      generation: 1,
      resourceVersion: "1",
      creationTimestamp: "2026-08-21T00:00:00.000Z",
    },
    spec,
    status,
  };
}

function memoryResources(
  initial: readonly Readonly<Resource<unknown, unknown>>[],
): {
  readonly client: ResourceClient;
  readonly get: <TSpec, TStatus>(
    type: ResourceType,
    name: string,
  ) => Readonly<Resource<TSpec, TStatus>> | undefined;
} {
  const values = new Map(initial.map((item) => [
    `${item.kind}/${item.metadata.namespace}/${item.metadata.name}`,
    item,
  ]));
  const key = (type: ResourceType, namespace: string, name: string) =>
    `${type.kind}/${namespace}/${name}`;
  const client = {
    async get<TSpec, TStatus>(ref: ResourceRef) {
      return values.get(key(ref, ref.namespace, ref.name)) as
        | Readonly<Resource<TSpec, TStatus>>
        | undefined;
    },
    async list<TSpec, TStatus>(
      type: ResourceType,
      options?: { readonly namespace?: "v1" },
    ) {
      return [...values.values()].filter((item) =>
        item.apiVersion === type.apiVersion &&
        item.kind === type.kind &&
        (options?.namespace === undefined ||
          item.metadata.namespace === options.namespace)
      ) as readonly Readonly<Resource<TSpec, TStatus>>[];
    },
    async create() {
      throw new Error("not used");
    },
    async delete() {
      throw new Error("not used");
    },
    async patchMetadata<TSpec, TStatus>(
      current: Readonly<Resource<TSpec, TStatus>>,
    ) {
      return current;
    },
    async patchStatus<TSpec, TStatus>(
      current: Readonly<Resource<TSpec, TStatus>>,
      patch: Partial<TStatus>,
    ) {
      const updated = {
        ...current,
        metadata: {
          ...current.metadata,
          resourceVersion: String(Number(current.metadata.resourceVersion) + 1),
        },
        status: { ...current.status, ...patch },
      };
      values.set(
        key(current, current.metadata.namespace, current.metadata.name),
        updated as Readonly<Resource<unknown, unknown>>,
      );
      return updated;
    },
  } as ResourceClient;
  return {
    client,
    get<TSpec, TStatus>(type: ResourceType, name: string) {
      return values.get(key(type, "v1", name)) as
        | Readonly<Resource<TSpec, TStatus>>
        | undefined;
    },
  };
}

const environmentSpec: EnvironmentSpec = {
  identity: { product: "agentsphere", name: "dev" },
  displayName: "Development",
  targets: [{
    kind: "kubernetes",
    name: "primary",
    source: "dev-cluster",
    cluster: "dev.example",
  }],
};

const serviceSpec: ServiceSpec = {
  component: { product: "agentsphere", name: "chat-server" },
  environment: { product: "agentsphere", name: "dev" },
  deployment: {
    kind: "kubernetes",
    target: "primary",
    namespace: "agentsphere",
    deployments: ["chat-server"],
    services: ["chat-server"],
    configMaps: ["chat-server"],
  },
  url: "https://dev.example/chat",
};

describe("Deployment catalog", () => {
  test("materializes global Product, Component, Environment, and Service Resources", async () => {
    const path = configFile({
      version: 2,
      products: {
        agentsphere: {
          displayName: "AgentSphere",
          components: {
            "chat-server": {
              displayName: "Chat Server",
              repository: {
                forge: " github.com ",
                path: " compforge/chat-server ",
              },
            },
          },
          environments: {
            dev: {
              displayName: "Development",
              targets: [{
                kind: "kubernetes",
                name: "primary",
                source: "dev-cluster",
                cluster: "dev.example",
              }],
            },
            staging: {
              displayName: "Staging without Kubernetes",
            },
          },
          services: {
            "chat-server-dev": {
              component: "chat-server",
              environment: "dev",
              deployment: serviceSpec.deployment,
              url: serviceSpec.url,
            },
          },
        },
      },
      kubernetes: {
        "dev-cluster": {
          kubeconfig: "/configs/dev.kubeconfig",
          context: "dev",
        },
      },
    });

    const catalog = loadDeploymentCatalog(path);
    expect(catalog.products).toEqual([{
      identity: { name: "agentsphere" },
      displayName: "AgentSphere",
    }]);
    expect(catalog.components).toEqual([{
      identity: { product: "agentsphere", name: "chat-server" },
      repository: {
        forge: "github.com",
        path: "compforge/chat-server",
      },
      displayName: "Chat Server",
    }]);
    expect(catalog.environments).toHaveLength(2);
    expect(catalog.environments[1]?.targets).toEqual([]);
    expect(catalog.services).toEqual([serviceSpec]);
    expect(loadKubernetesConnectorConfigs(path)).toEqual([{
      source: "dev-cluster",
      kubeconfig: "/configs/dev.kubeconfig",
      context: "dev",
    }]);

    const sources = deploymentCatalogSources(catalog);
    const emitted: unknown[] = [];
    await sources.products[0]!.start(sourceContext(emitted));
    await sources.components[0]!.start(sourceContext(emitted));
    await sources.environments[0]!.start(sourceContext(emitted));
    await sources.services[0]!.start(sourceContext(emitted));
    expect(emitted).toHaveLength(5);
    expect(emitted).toContainEqual({
      name: productResourceName({ name: "agentsphere" }),
      namespace: "v1",
      spec: catalog.products[0],
    });
    expect(emitted).toContainEqual({
      name: componentResourceName({
        product: "agentsphere",
        name: "chat-server",
      }),
      namespace: "v1",
      spec: catalog.components[0],
    });
    expect(emitted).toContainEqual({
      name: serviceResourceName(serviceSpec),
      namespace: "v1",
      spec: serviceSpec,
    });
  });

  test("rejects an incomplete Component Repository identity", () => {
    const path = configFile({
      version: 2,
      products: {
        agentsphere: {
          components: {
            "chat-server": {
              repository: {
                forge: "github.com",
              },
            },
          },
        },
      },
    });

    expect(() => loadDeploymentCatalog(path)).toThrow(
      "reqloop component agentsphere/chat-server repository path must not be empty",
    );
  });

  test("rejects a Service outside its Environment targets", () => {
    const path = configFile({
      version: 2,
      products: {
        product: {
          components: { api: {} },
          environments: { dev: {} },
          services: {
            "api-dev": {
              component: "api",
              environment: "dev",
              deployment: {
                kind: "kubernetes",
                target: "primary",
                namespace: "default",
                deployments: ["api"],
              },
            },
          },
        },
      },
    });

    expect(() => loadDeploymentCatalog(path)).toThrow(
      "references unknown Kubernetes target: primary",
    );
  });

  test("rejects a Service whose Component and Environment cross Products", () => {
    expect(() => normalizeServiceSpec({
      ...serviceSpec,
      environment: { product: "notebook", name: "dev" },
    })).toThrow(
      "Service Component and Environment must belong to the same Product",
    );
  });

  test("keeps same-named Environments isolated by Product", () => {
    const path = configFile({
      version: 2,
      products: {
        agentsphere: { environments: { dev: {} } },
        notebook: { environments: { dev: {} } },
      },
    });

    const environments = loadDeploymentCatalog(path).environments;
    expect(environments.map(({ identity }) => identity)).toEqual([
      { product: "agentsphere", name: "dev" },
      { product: "notebook", name: "dev" },
    ]);
    expect(new Set(environments.map(({ identity }) =>
      environmentResourceName(identity)
    )).size).toBe(2);
  });
});

describe("Kubernetes deployment observation", () => {
  test("reads cluster and workload facts through bounded kubectl calls", async () => {
    const calls: string[][] = [];
    const connector = new KubectlKubernetesConnector(
      {
        source: "dev-cluster",
        kubeconfig: "/configs/dev.kubeconfig",
        context: "dev",
      },
      async (args) => {
        calls.push([...args]);
        if (args.includes("version")) {
          return { serverVersion: { gitVersion: "v1.34.1" } };
        }
        return {
          kind: "List",
          items: [{
            kind: "Deployment",
            metadata: {
              name: "chat-server",
              namespace: "agentsphere",
              generation: 4,
              resourceVersion: "101",
            },
            spec: {
              replicas: 2,
              template: {
                metadata: {
                  labels: { "app.kubernetes.io/version": "sha-abc123" },
                },
                spec: {
                  containers: [{
                    name: "chat-server",
                    image: "registry.example/chat-server:sha-abc123",
                  }],
                },
              },
            },
            status: {
              observedGeneration: 4,
              readyReplicas: 2,
              updatedReplicas: 2,
              availableReplicas: 2,
            },
          }, {
            kind: "Service",
            metadata: {
              name: "chat-server",
              namespace: "agentsphere",
              resourceVersion: "102",
            },
          }, {
            kind: "ConfigMap",
            metadata: {
              name: "chat-server",
              namespace: "agentsphere",
              resourceVersion: "103",
            },
          }],
        };
      },
      () => new Date("2026-08-21T08:00:00.000Z"),
    );
    const target = environmentSpec.targets[0]!;

    expect(await connector.observeEnvironment(target)).toEqual({
      observedAt: "2026-08-21T08:00:00.000Z",
      version: "v1.34.1",
    });
    const service = await connector.observeService(
      target,
      serviceSpec.deployment,
    );
    expect(service).toMatchObject({
      phase: "ready",
      deployedRevision: "sha-abc123",
      artifacts: ["registry.example/chat-server:sha-abc123"],
      workloads: [{
        kind: "Deployment",
        namespace: "agentsphere",
        name: "chat-server",
        desired: 2,
        ready: 2,
        phase: "ready",
      }],
      observedAt: "2026-08-21T08:00:00.000Z",
    });
    expect(service.objects).toContainEqual({
      kind: "ConfigMap",
      namespace: "agentsphere",
      name: "chat-server",
      resourceVersion: "103",
    });
    expect(calls[1]).toEqual([
      "--kubeconfig",
      "/configs/dev.kubeconfig",
      "--context",
      "dev",
      "--request-timeout=15s",
      "get",
      "deployment/chat-server",
      "service/chat-server",
      "configmap/chat-server",
      "--namespace",
      "agentsphere",
      "--output=json",
    ]);
  });

  test("reconciles Environment and Service into a shared global view", async () => {
    const environment = resource<EnvironmentSpec, EnvironmentStatus>(
      ENVIRONMENT_RESOURCE_TYPE,
      environmentResourceName(environmentSpec.identity),
      environmentSpec,
      {},
    );
    const service = resource<ServiceSpec, ServiceStatus>(
      SERVICE_RESOURCE_TYPE,
      serviceResourceName(serviceSpec),
      serviceSpec,
      {},
    );
    const resources = memoryResources([environment, service]);
    let serviceObservationError: Error | undefined;
    const connector: KubernetesConnector = {
      source: "dev-cluster",
      async observeEnvironment() {
        return {
          observedAt: "2026-08-21T08:00:00.000Z",
          version: "v1.34.1",
        };
      },
      async observeService() {
        if (serviceObservationError) throw serviceObservationError;
        return {
          phase: "ready",
          deployedRevision: "sha-abc123",
          artifacts: ["registry.example/chat-server:sha-abc123"],
          workloads: [{
            kind: "Deployment",
            namespace: "agentsphere",
            name: "chat-server",
            desired: 2,
            ready: 2,
            phase: "ready",
          }],
          objects: [],
          observedAt: "2026-08-21T08:00:00.000Z",
        };
      },
    };

    const environmentController = createEnvironmentController(
      resources.client,
      [connector],
    );
    await environmentController.reconcile({} as never, environment);
    expect(resources.get<EnvironmentSpec, EnvironmentStatus>(
      ENVIRONMENT_RESOURCE_TYPE,
      environment.metadata.name,
    )?.status).toEqual({
      phase: "available",
      targets: [{
        kind: "kubernetes",
        name: "primary",
        phase: "available",
        observedAt: "2026-08-21T08:00:00.000Z",
        version: "v1.34.1",
      }],
    });

    const serviceController = createServiceController(
      resources.client,
      [connector],
    );
    await serviceController.reconcile({} as never, service);
    let current = resources.get<ServiceSpec, ServiceStatus>(
      SERVICE_RESOURCE_TYPE,
      service.metadata.name,
    )!;
    expect(current.status).toMatchObject({
      phase: "ready",
      deployedRevision: "sha-abc123",
      message: null,
    });
    expect(await serviceController.present?.(current)).toMatchObject({
      title: "agentsphere/chat-server",
      status: "agentsphere/dev · ready · sha-abc123",
      tone: "success",
      url: "https://dev.example/chat",
    });
    expect(await serviceController.watches?.[0]?.handler.update({
      oldObject: environment,
      newObject: resources.get(
        ENVIRONMENT_RESOURCE_TYPE,
        environment.metadata.name,
      )!,
    })).toEqual([{
      name: service.metadata.name,
      namespace: "v1",
    }]);

    serviceObservationError = new Error("cluster unavailable");
    await serviceController.reconcile({} as never, current);
    current = resources.get<ServiceSpec, ServiceStatus>(
      SERVICE_RESOURCE_TYPE,
      service.metadata.name,
    )!;
    expect(current.status).toMatchObject({
      phase: "unavailable",
      deployedRevision: null,
      artifacts: [],
      workloads: [],
      objects: [],
      message: "cluster unavailable",
    });
    expect(await serviceController.present?.(current)).toMatchObject({
      status: "agentsphere/dev · unavailable",
      detail: "cluster unavailable",
      tone: "error",
    });
  });
});
