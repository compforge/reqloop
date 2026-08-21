import type {
  Controller,
  Resource,
  ResourceClient,
  Source,
} from "@compforge/baton-plugin";

import { boardPriority } from "../board.ts";
import { enqueueRequestsFromMapFunc } from "../event-handler.ts";
import type {
  ComponentSpec,
  ComponentStatus,
  EnvironmentPhase,
  EnvironmentSpec,
  EnvironmentStatus,
  EnvironmentTargetStatus,
  KubernetesConnector,
  KubernetesEnvironmentTarget,
  ServicePhase,
  ServiceSpec,
  ServiceStatus,
} from "./protocol.ts";
import {
  COMPONENT_RESOURCE_TYPE,
  ENVIRONMENT_RESOURCE_TYPE,
  SERVICE_RESOURCE_TYPE,
} from "./resource.ts";

const DEPLOYMENT_OBSERVATION_CRON = "*/30 * * * * *";
const MAX_OBSERVATION_MESSAGE_LENGTH = 2_000;

function connectorsBySource(
  connectors: readonly KubernetesConnector[],
): ReadonlyMap<string, KubernetesConnector> {
  const result = new Map<string, KubernetesConnector>();
  for (const connector of connectors) {
    if (result.has(connector.source)) {
      throw new Error(`duplicate KubernetesConnector source: ${connector.source}`);
    }
    result.set(connector.source, connector);
  }
  return result;
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length <= MAX_OBSERVATION_MESSAGE_LENGTH
    ? message
    : `${message.slice(0, MAX_OBSERVATION_MESSAGE_LENGTH - 1)}…`;
}

function environmentPhase(
  targets: readonly EnvironmentTargetStatus[],
): EnvironmentPhase {
  if (targets.length === 0) return "unknown";
  return targets.some(({ phase }) => phase === "unavailable")
    ? "unavailable"
    : targets.every(({ phase }) => phase === "available")
    ? "available"
    : "unknown";
}

function environmentTone(phase: EnvironmentPhase) {
  if (phase === "available") return "success" as const;
  if (phase === "unavailable") return "error" as const;
  return "muted" as const;
}

function serviceTone(phase: ServicePhase) {
  if (phase === "ready") return "success" as const;
  if (phase === "degraded" || phase === "unavailable") {
    return "error" as const;
  }
  if (phase === "progressing") return "warning" as const;
  return "muted" as const;
}

function servicePriority(phase: ServicePhase): number {
  if (phase === "unavailable") return 500;
  if (phase === "degraded") return 450;
  if (phase === "progressing") return 300;
  if (phase === "unknown") return 200;
  return 100;
}

/** @rule An unavailable Service must not expose facts from an earlier successful observation. */
function unavailableServiceStatus(
  observedAt: string,
  message: string,
): Partial<ServiceStatus> {
  return {
    phase: "unavailable",
    deployedRevision: null,
    artifacts: Object.freeze([]),
    workloads: Object.freeze([]),
    objects: Object.freeze([]),
    observedAt,
    message,
  };
}

export function createComponentController(
  sources: readonly Source<ComponentSpec>[] = [],
): Controller<ComponentSpec, ComponentStatus> {
  return {
    resourceType: COMPONENT_RESOURCE_TYPE,
    ...(sources.length > 0 ? { sources } : {}),
    async reconcile() {},
  };
}

export function createEnvironmentController(
  resources: ResourceClient,
  connectors: readonly KubernetesConnector[] = [],
  sources: readonly Source<EnvironmentSpec>[] = [],
): Controller<EnvironmentSpec, EnvironmentStatus> {
  const connectorMap = connectorsBySource(connectors);
  return {
    resourceType: ENVIRONMENT_RESOURCE_TYPE,
    sources: [
      ...sources,
      ...(connectors.length > 0
        ? [{
          type: "cron" as const,
          sourceId: "environment-observation",
          cron: DEPLOYMENT_OBSERVATION_CRON,
          timeZone: "UTC",
        }]
        : []),
    ],
    maxConcurrency: 2,
    async reconcile(_context, resource) {
      const targets: EnvironmentTargetStatus[] = [];
      for (const target of resource.spec.targets) {
        const connector = connectorMap.get(target.source);
        if (!connector) {
          targets.push(Object.freeze({
            kind: target.kind,
            name: target.name,
            phase: "unavailable",
            message: `Kubernetes Connector is not configured: ${target.source}`,
          }));
          continue;
        }
        try {
          const observation = await connector.observeEnvironment(target);
          targets.push(Object.freeze({
            kind: target.kind,
            name: target.name,
            phase: "available",
            observedAt: observation.observedAt,
            ...(observation.version ? { version: observation.version } : {}),
          }));
        } catch (error) {
          targets.push(Object.freeze({
            kind: target.kind,
            name: target.name,
            phase: "unavailable",
            observedAt: new Date().toISOString(),
            message: errorMessage(error),
          }));
        }
      }
      await resources.patchStatus(resource, {
        phase: environmentPhase(targets),
        targets: Object.freeze(targets),
      });
    },
    async present(resource) {
      const phase = resource.status.phase ?? "unknown";
      const targetSummary = resource.spec.targets.length === 0
        ? "No deployment target"
        : resource.spec.targets.map(({ kind, name, cluster }) =>
          `${kind}:${name} (${cluster})`
        ).join(" · ");
      return {
        title: resource.spec.displayName ?? resource.spec.identity.name,
        status: phase,
        detail: targetSummary,
        tone: environmentTone(phase),
        priority: boardPriority(
          phase === "unavailable" ? 400 : phase === "unknown" ? 200 : 100,
          resource.metadata.creationTimestamp,
        ),
      };
    },
  };
}

function sameEnvironment(
  left: EnvironmentSpec["identity"],
  right: EnvironmentSpec["identity"],
): boolean {
  return left.name === right.name;
}

function environmentServices(resources: ResourceClient) {
  return enqueueRequestsFromMapFunc<EnvironmentSpec, EnvironmentStatus>(
    async (environment) =>
      (await resources.list<ServiceSpec, ServiceStatus>(
        SERVICE_RESOURCE_TYPE,
        { namespace: "v1" },
      )).filter(({ spec }) =>
        sameEnvironment(spec.environment, environment.spec.identity)
      ).map(({ metadata }) => ({
        name: metadata.name,
        namespace: "v1" as const,
      })),
  );
}

async function globalEnvironment(
  resources: ResourceClient,
  identity: EnvironmentSpec["identity"],
): Promise<Readonly<Resource<EnvironmentSpec, EnvironmentStatus>> | undefined> {
  return (await resources.list<EnvironmentSpec, EnvironmentStatus>(
    ENVIRONMENT_RESOURCE_TYPE,
    { namespace: "v1" },
  )).find(({ spec }) => sameEnvironment(spec.identity, identity));
}

function kubernetesTarget(
  environment: EnvironmentSpec,
  targetName: string,
): KubernetesEnvironmentTarget | undefined {
  return environment.targets.find(({ kind, name }) =>
    kind === "kubernetes" && name === targetName
  );
}

export function createServiceController(
  resources: ResourceClient,
  connectors: readonly KubernetesConnector[] = [],
  sources: readonly Source<ServiceSpec>[] = [],
): Controller<ServiceSpec, ServiceStatus> {
  const connectorMap = connectorsBySource(connectors);
  return {
    resourceType: SERVICE_RESOURCE_TYPE,
    watches: [{
      resourceType: ENVIRONMENT_RESOURCE_TYPE,
      handler: environmentServices(resources),
    }],
    sources: [
      ...sources,
      ...(connectors.length > 0
        ? [{
          type: "cron" as const,
          sourceId: "service-observation",
          cron: DEPLOYMENT_OBSERVATION_CRON,
          timeZone: "UTC",
        }]
        : []),
    ],
    maxConcurrency: 4,
    async reconcile(_context, resource) {
      const observedAt = new Date().toISOString();
      const environment = await globalEnvironment(
        resources,
        resource.spec.environment,
      );
      if (!environment) {
        await resources.patchStatus(
          resource,
          unavailableServiceStatus(
            observedAt,
            `Environment is not materialized: ${resource.spec.environment.name}`,
          ),
        );
        return;
      }
      const target = kubernetesTarget(
        environment.spec,
        resource.spec.deployment.target,
      );
      if (!target) {
        await resources.patchStatus(
          resource,
          unavailableServiceStatus(
            observedAt,
            `Environment Kubernetes target is not available: ${resource.spec.deployment.target}`,
          ),
        );
        return;
      }
      const connector = connectorMap.get(target.source);
      if (!connector) {
        await resources.patchStatus(
          resource,
          unavailableServiceStatus(
            observedAt,
            `Kubernetes Connector is not configured: ${target.source}`,
          ),
        );
        return;
      }
      try {
        const observation = await connector.observeService(
          target,
          resource.spec.deployment,
        );
        await resources.patchStatus(resource, {
          ...observation,
          message: null,
        });
      } catch (error) {
        await resources.patchStatus(
          resource,
          unavailableServiceStatus(observedAt, errorMessage(error)),
        );
      }
    },
    async present(resource) {
      const phase = resource.status.phase ?? "unknown";
      const revision = resource.status.deployedRevision
        ? ` · ${resource.status.deployedRevision}`
        : "";
      const workloads = resource.status.workloads?.map((workload) =>
        `${workload.name} ${workload.ready}/${workload.desired}`
      ).join(" · ") ?? "Deployment not observed";
      return {
        title: `${resource.spec.component.product}/${resource.spec.component.name}`,
        status: `${resource.spec.environment.name} · ${phase}${revision}`,
        detail: resource.status.message ?? workloads,
        ...(resource.spec.url ? { url: resource.spec.url } : {}),
        tone: serviceTone(phase),
        priority: boardPriority(
          servicePriority(phase),
          resource.metadata.creationTimestamp,
        ),
      };
    },
  };
}
