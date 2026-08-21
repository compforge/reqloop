export interface ProductIdentity {
  readonly name: string;
}

/**
 * @spec Product is the stable owner that scopes Component, Environment, and Service identities in one deployment catalog.
 * @see {@link ../../docs/deployment.md}
 */
export interface ProductSpec {
  readonly identity: ProductIdentity;
  readonly displayName?: string;
  readonly description?: string;
}

export type ProductStatus = Readonly<Record<string, never>>;

export interface ComponentIdentity {
  readonly product: string;
  readonly name: string;
}

export interface ComponentSpec {
  readonly identity: ComponentIdentity;
  readonly displayName?: string;
  readonly description?: string;
}

export type ComponentStatus = Readonly<Record<string, never>>;

/** One deployment substrate that belongs to an Environment. */
export interface KubernetesEnvironmentTarget {
  readonly kind: "kubernetes";
  /** Stable target name within the Environment, for example `primary`. */
  readonly name: string;
  /** KubernetesConnector identity; access details remain in Plugin config. */
  readonly source: string;
  /** Stable external cluster identity shown to users. */
  readonly cluster: string;
}

export type EnvironmentTarget = KubernetesEnvironmentTarget;

export interface EnvironmentIdentity {
  readonly product: string;
  readonly name: string;
}

/**
 * @spec An Environment belongs to one Product and owns its deployment targets; Kubernetes is an explicit target kind, while a valid non-Kubernetes Environment may currently have no targets.
 * @see {@link ../../docs/deployment.md}
 */
export interface EnvironmentSpec {
  readonly identity: EnvironmentIdentity;
  readonly displayName?: string;
  readonly description?: string;
  readonly targets: readonly EnvironmentTarget[];
}

export type EnvironmentPhase = "unknown" | "available" | "unavailable";

export interface EnvironmentTargetStatus {
  readonly kind: EnvironmentTarget["kind"];
  readonly name: string;
  readonly phase: EnvironmentPhase;
  readonly observedAt?: string;
  readonly version?: string;
  readonly message?: string;
}

export interface EnvironmentStatus {
  readonly phase?: EnvironmentPhase;
  readonly targets?: readonly EnvironmentTargetStatus[];
}

/** Kubernetes objects implementing one Component instance. */
export interface KubernetesServiceDeployment {
  readonly kind: "kubernetes";
  /** Name of a Kubernetes target declared by the Environment. */
  readonly target: string;
  readonly namespace: string;
  readonly deployments: readonly string[];
  readonly services?: readonly string[];
  readonly configMaps?: readonly string[];
}

export type ServiceDeployment = KubernetesServiceDeployment;

/**
 * @spec One Service is one Component instance in an Environment of the same Product and maps only to a target owned by that Environment.
 * @see {@link ../../docs/deployment.md}
 */
export interface ServiceSpec {
  readonly component: ComponentIdentity;
  readonly environment: EnvironmentIdentity;
  readonly deployment: ServiceDeployment;
  readonly url?: string;
}

export type ServicePhase =
  | "unknown"
  | "progressing"
  | "ready"
  | "degraded"
  | "unavailable";

export interface WorkloadObservation {
  readonly kind: string;
  readonly namespace: string;
  readonly name: string;
  readonly desired: number;
  readonly ready: number;
  readonly phase: "progressing" | "ready" | "degraded";
}

export interface DeploymentObjectObservation {
  readonly kind: string;
  readonly namespace: string;
  readonly name: string;
  readonly resourceVersion?: string;
}

export interface ServiceStatus {
  readonly phase?: ServicePhase;
  readonly deployedRevision?: string | null;
  readonly artifacts?: readonly string[];
  readonly workloads?: readonly WorkloadObservation[];
  readonly objects?: readonly DeploymentObjectObservation[];
  readonly observedAt?: string;
  readonly message?: string | null;
}

export interface KubernetesEnvironmentObservation {
  readonly observedAt: string;
  readonly version?: string;
}

export interface KubernetesServiceObservation {
  readonly phase: Exclude<ServicePhase, "unknown" | "unavailable">;
  readonly deployedRevision: string | null;
  readonly artifacts: readonly string[];
  readonly workloads: readonly WorkloadObservation[];
  readonly objects: readonly DeploymentObjectObservation[];
  readonly observedAt: string;
}

/** ReqLoop-owned port for observing Kubernetes deployment facts. */
export interface KubernetesConnector {
  readonly source: string;
  observeEnvironment(
    target: KubernetesEnvironmentTarget,
  ): Promise<KubernetesEnvironmentObservation>;
  observeService(
    target: KubernetesEnvironmentTarget,
    deployment: KubernetesServiceDeployment,
  ): Promise<KubernetesServiceObservation>;
}
