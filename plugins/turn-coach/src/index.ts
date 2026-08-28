import type {
  BatonTurnResourceData,
  PluginContext,
  PluginPackage,
} from "@compforge/baton-plugin";

const BATON_TURN_RESOURCE_TYPE = Object.freeze({
  apiVersion: "baton.dev/v1alpha1",
  kind: "Turn",
} as const);

interface TurnCoachSpec {
  enabled: boolean;
}

interface TurnCoachStatus {
  activatedAt?: string;
  coachedTurns?: number;
  lastCoachedAt?: string;
  lastCoachedResourceVersion?: string;
  lastTurnId?: string;
  observedGeneration?: number;
}

const RESOURCE_TYPE = Object.freeze({
  apiVersion: "turn-coach.baton.dev/v1alpha1",
  kind: "TurnCoachState",
} as const);
const RESOURCE_ID = "main";
const MAX_REQUEST_LENGTH = 160;
const DRAFT_TIMEOUT_MS = 7 * 24 * 60 * 60_000;

function requestSummary(userText: string): string {
  const normalized = userText.trim().replace(/\s+/g, " ");
  if (!normalized) return "(empty request)";
  if (normalized.length <= MAX_REQUEST_LENGTH) return normalized;
  return `${normalized.slice(0, MAX_REQUEST_LENGTH - 1)}…`;
}

function proposedInput(userText: string): string {
  return [
    "Review the previous turn against the original request below.",
    "Identify missing work or material risks, then recommend the single best next step.",
    "",
    `Original request: ${requestSummary(userText)}`,
  ].join("\n");
}

const turnCoach: PluginPackage = Object.freeze({
  pluginId: "compforge/turn-coach",
  version: "0.1.0",

  async activate(context: PluginContext): Promise<void> {
    let initialState = (await context.resources
      .list<TurnCoachSpec, TurnCoachStatus>(RESOURCE_TYPE))
      .find((resource) => resource.metadata.name === RESOURCE_ID);
    if (!initialState) {
      initialState = await context.resources.create<TurnCoachSpec, TurnCoachStatus>(
        RESOURCE_TYPE,
        {
          name: RESOURCE_ID,
          spec: { enabled: true },
        },
      );
      await context.resources.patchStatus(initialState, {
        activatedAt: new Date().toISOString(),
        coachedTurns: 0,
        observedGeneration: initialState.metadata.generation,
      });
    }

    context.controllers.register<TurnCoachSpec, TurnCoachStatus>({
      resourceType: RESOURCE_TYPE,
      async reconcile(_baton, resource) {
        if (resource.status.observedGeneration === resource.metadata.generation) return;
        await context.resources.patchStatus(resource, {
          observedGeneration: resource.metadata.generation,
        });
      },
    });

    context.controllers.register<Record<string, never>, BatonTurnResourceData>({
      resourceType: BATON_TURN_RESOURCE_TYPE,
      async reconcile(reconcile, turn) {
        const state = (await context.resources
          .list<TurnCoachSpec, TurnCoachStatus>(RESOURCE_TYPE))
          .find((resource) => resource.metadata.name === RESOURCE_ID);

        if (!state) {
          throw new Error(
            `${RESOURCE_TYPE.kind}/${RESOURCE_ID} is missing`,
          );
        }
        if (!state.spec.enabled) return;
        if (
          state.status.activatedAt &&
          turn.metadata.creationTimestamp < state.status.activatedAt
        ) {
          // First enable may replay a long existing ledger. The persisted
          // activation boundary keeps that history from flooding the composer.
          return;
        }

        const lastCoachedAt = state.status.lastCoachedAt;
        if (
          (lastCoachedAt && turn.metadata.creationTimestamp < lastCoachedAt) ||
          turn.metadata.resourceVersion === state.status.lastCoachedResourceVersion
        ) {
          return;
        }

        // Persist the watermark before requesting a draft. The modern verb is a
        // live continuation and is intentionally not replayed after a crash.
        await context.resources.patchStatus(state, {
          coachedTurns: reconcile.snapshot.turns.length,
          lastCoachedAt: turn.metadata.creationTimestamp,
          lastCoachedResourceVersion: turn.metadata.resourceVersion,
          lastTurnId: turn.status.turnId,
          observedGeneration: state.metadata.generation,
        });
        await reconcile.verbs.draft({
          title: "Review the previous turn",
          prompt: proposedInput(turn.status.userText ?? ""),
          timeoutMs: DRAFT_TIMEOUT_MS,
        });
      },
    });
  },
});

export default turnCoach;
