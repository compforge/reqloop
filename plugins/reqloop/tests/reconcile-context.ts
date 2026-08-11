import type {
  AskInput,
  AskResult,
  ConfirmInput,
  DraftInput,
  DraftResult,
  HarnessInput,
  HarnessResult,
  ReconcileContext,
  ReconcileSnapshot,
  WithdrawInput,
  WithdrawResult,
} from "@compforge/baton-plugin";

const SNAPSHOT: ReconcileSnapshot = {
  session: {
    batonSessionId: "bs_test",
    runState: "idle",
    revision: 0,
  },
  activeTurns: [],
  inputs: [],
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
  readonly answers?: Readonly<Record<string, AskResult<string>>>;
  readonly draftResults?: Readonly<Record<string, DraftResult>>;
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
    async ask(input: AskInput): Promise<AskResult<string>> {
      asks.push(input);
      return options.answers?.[input.key] ?? { state: "waiting" };
    },
    async confirm(_input: ConfirmInput) {
      return { state: "waiting" as const };
    },
    async withdraw(_input: WithdrawInput): Promise<WithdrawResult> {
      return { state: "not-pending" };
    },
    async draft(input: DraftInput): Promise<DraftResult> {
      drafts.push(input);
      return options.draftResults?.[input.key] ?? { state: "editing" };
    },
    async harness(_input: HarnessInput): Promise<HarnessResult> {
      return { state: "waiting" };
    },
  } as ReconcileContext;
  return { context, asks, drafts };
}
