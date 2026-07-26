/** Provider-neutral lifecycle state used by Requirement Loop policy. */
export type RequirementState =
  | "open"
  | "in_progress"
  | "completed"
  | "closed"
  | "unknown";

/**
 * Source identifies the configured Connector. Category is provider-defined:
 * reqloop displays and passes it back unchanged, but never branches on it.
 */
export interface RequirementIdentity {
  readonly source: string;
  readonly id: string;
  readonly category: string;
}

/**
 * The list shape stays compact. Provider is intentionally absent: it belongs
 * to the configured Connector, just as devloop's forge belongs to a Repo.
 */
export interface RequirementSummary extends RequirementIdentity {
  readonly title: string;
  readonly state: RequirementState;
  readonly url?: string;
  readonly assignee?: string;
  readonly updatedAt?: string;
}

export interface Requirement extends RequirementSummary {
  readonly description?: string;
  readonly acceptanceCriteria?: readonly string[];
}

export interface RequirementSpec {
  readonly identity: RequirementIdentity;
  readonly title: string;
  readonly description?: string;
  readonly acceptanceCriteria?: readonly string[];
}

export interface RequirementStatus {
  readonly externalState?: RequirementState;
  readonly assignee?: string;
  readonly updatedAt?: string;
  readonly url?: string;
}

export interface RequirementListQuery {
  readonly text?: string;
  readonly limit?: number;
}

/**
 * Requirement-platform port expressed only in reqloop domain terms.
 * Meego and future providers map their DTOs at this boundary.
 */
export interface RequirementConnector {
  /** Stable config key used to route a selected Requirement back here. */
  readonly source: string;
  /** Connector-level provenance; Requirement values remain provider-neutral. */
  readonly provider: string;
  list(
    query?: RequirementListQuery,
  ): Promise<readonly RequirementSummary[]>;
  get(identity: RequirementIdentity): Promise<Requirement>;
}
