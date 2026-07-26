/** Provider-neutral lifecycle state used by Requirement Loop policy. */
export type RequirementState =
  | "open"
  | "in_progress"
  | "completed"
  | "closed"
  | "unknown";

/**
 * The list shape stays compact. Provider is intentionally absent: it belongs
 * to the configured Connector, just as devloop's forge belongs to a Repo.
 */
export interface RequirementSummary {
  readonly id: string;
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

export interface RequirementListQuery {
  readonly text?: string;
  readonly limit?: number;
}

/**
 * Requirement-platform port expressed only in reqloop domain terms.
 * Meego and future providers map their DTOs at this boundary.
 */
export interface RequirementConnector {
  /** Connector-level provenance; Requirement values remain provider-neutral. */
  readonly provider: string;
  list(
    query?: RequirementListQuery,
  ): Promise<readonly RequirementSummary[]>;
  get(requirementId: string): Promise<Requirement>;
}
