import type {
  AskInput,
  AskResult,
  ConfirmInput,
  DraftInput,
  DraftResult,
  HarnessInvocationInput,
  HarnessResult,
  ReconcileContext,
  ReconcileSnapshot,
} from "@compforge/baton-plugin";

export const TEST_NAMESPACE = "v1/project/project-test" as const;

const SNAPSHOT: ReconcileSnapshot = {
  session: {
    batonSessionId: "bs_test",
    runState: "idle",
    revision: 0,
  },
  activeTurns: [],
  harnessInputs: [],
  harnessTargets: [],
  pendingInteractions: [],
  turns: [],
};

export interface ReconcileContextFixture {
  readonly context: ReconcileContext;
  readonly asks: AskInput[];
  readonly drafts: DraftInput[];
}

export function reconcileContext(options: {
  readonly cwd?: string;
  readonly answer?: AskResult<string>;
  readonly draftResult?: DraftResult;
} = {}): ReconcileContextFixture {
  const asks: AskInput[] = [];
  const drafts: DraftInput[] = [];
  const snapshot = options.cwd === undefined
    ? SNAPSHOT
    : {
      ...SNAPSHOT,
      session: { ...SNAPSHOT.session, cwd: options.cwd },
    };
  const context = {
    snapshot,
    verbs: {
      async ask(input: AskInput): Promise<AskResult<string>> {
        asks.push(input);
        return options.answer ?? { state: "dismissed" };
      },
      async confirm(_input: ConfirmInput) {
        return { state: "dismissed" as const };
      },
      async draft(input: DraftInput): Promise<DraftResult> {
        drafts.push(input);
        return options.draftResult ?? {
          state: "success",
          value: {
            outcome: "completed",
            laneId: "main",
            turn: { turnId: "turn_test", toolCalls: [] },
          },
        };
      },
      async harness(_input: HarnessInvocationInput): Promise<HarnessResult> {
        return { state: "dismissed" };
      },
    },
  } as ReconcileContext;
  return { context, asks, drafts };
}
