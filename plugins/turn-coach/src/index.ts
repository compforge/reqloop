import type {
  BatonTurnResourceData,
  PluginActivationContext,
  PluginPackage,
} from "@qiankun01/baton-plugin";

interface TurnCoachSpec {
  enabled: boolean;
}

interface TurnCoachStatus {
  activatedAt?: string;
  coachedTurns?: number;
  lastCoachedRevision?: number;
  lastTurnId?: string;
  observedGeneration?: number;
}

const RESOURCE_KIND = "TurnCoachState";
const RESOURCE_ID = "main";
const MAX_REQUEST_LENGTH = 160;

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
  pluginId: "qiankunli/turn-coach",
  version: "0.0.2",

  activate(context: PluginActivationContext): void {
    let initialState = context.resources
      .list<TurnCoachSpec, TurnCoachStatus>(RESOURCE_KIND)
      .find((resource) => resource.metadata.resourceId === RESOURCE_ID);
    if (!initialState) {
      initialState = context.resources.create<TurnCoachSpec, TurnCoachStatus>(
        RESOURCE_KIND,
        {
          resourceId: RESOURCE_ID,
          spec: { enabled: true },
        },
      );
      context.resources.patchStatus(initialState, {
        activatedAt: new Date().toISOString(),
        coachedTurns: 0,
        lastCoachedRevision: 0,
        observedGeneration: initialState.metadata.generation,
      });
    }

    context.registerController<TurnCoachSpec, TurnCoachStatus>({
      resourceKind: RESOURCE_KIND,
      async reconcile(_baton, resource) {
        if (resource.status.observedGeneration === resource.metadata.generation) return;
        context.resources.patchStatus(resource, {
          observedGeneration: resource.metadata.generation,
        });
      },
    });

    context.registerController<Record<string, never>, BatonTurnResourceData>({
      resourceKind: "baton.turn",
      async reconcile(baton, turn) {
        const state = context.resources
          .list<TurnCoachSpec, TurnCoachStatus>(RESOURCE_KIND)
          .find((resource) => resource.metadata.resourceId === RESOURCE_ID);

        if (!state) throw new Error(`${RESOURCE_KIND}/${RESOURCE_ID} is missing`);
        if (!state.spec.enabled) return;
        if (
          state.status.activatedAt &&
          turn.metadata.updatedAt < state.status.activatedAt
        ) {
          // First enable may replay a long existing ledger. The persisted
          // activation boundary keeps that history from flooding the composer.
          return;
        }

        const lastRevision = state.status.lastCoachedRevision ?? 0;
        if (turn.metadata.resourceVersion > lastRevision) {
          context.resources.patchStatus(state, {
            coachedTurns: baton.turns.length,
            lastCoachedRevision: turn.metadata.resourceVersion,
            lastTurnId: turn.status.turnId,
            observedGeneration: state.metadata.generation,
          });
        }

        // Replay must return the same output: Baton persists and deduplicates the
        // Proposal, so a crash between reconcile and publication cannot lose it.
        return {
          output: {
            kind: "proposed-input",
            text: proposedInput(turn.status.userText ?? ""),
          },
        };
      },
    });
  },
});

export default turnCoach;
