import type {
  BatonTurnResourceData,
  PluginContext,
  PluginPackage,
} from "@compforge/baton-plugin";

const BATON_TURN_RESOURCE_TYPE = Object.freeze({
  apiVersion: "baton.dev/v1alpha1",
  kind: "Turn",
} as const);

interface CounterSpec {
  enabled: boolean;
}

interface CounterStatus {
  totalTurns: number;
  lastTurnId?: string;
  lastUserText?: string;
  observedGeneration: number;
}

const COUNTER_RESOURCE_TYPE = Object.freeze({
  apiVersion: "hello-counter.baton.dev/v1alpha1",
  kind: "CounterState",
} as const);

const helloCounter: PluginPackage = Object.freeze({
  pluginId: "compforge/hello-counter",
  version: "0.1.0",

  async activate(context: PluginContext): Promise<void> {
    // 1. 注册 CounterState Resource Controller
    context.controllers.register<CounterSpec, CounterStatus>({
      resourceType: COUNTER_RESOURCE_TYPE,
      async reconcile(_reconcile, _resource) {},
      async present(resource) {
        const totalTurns = resource.status.totalTurns;
        if (typeof totalTurns !== "number") return undefined;
        return {
          title: "Hello Counter",
          status: `${totalTurns} turn${totalTurns === 1 ? "" : "s"}`,
          ...(resource.status.lastUserText
            ? { detail: `Latest: ${resource.status.lastUserText}` }
            : {}),
          tone: resource.spec.enabled ? "success" : "muted",
        };
      },
    });

    // 2. Watch baton.turn，每次用户提问时更新计数
    context.controllers.register<Record<string, never>, BatonTurnResourceData>({
      resourceType: BATON_TURN_RESOURCE_TYPE,
      async reconcile(reconcile, turnResource) {
        // 查找或创建 CounterState
        const counterList = await context.resources.list<
          CounterSpec,
          CounterStatus
        >(COUNTER_RESOURCE_TYPE);

        let counter = counterList.find((c) => c.metadata.name === "main");

        if (!counter) {
          // 第一次：创建 CounterState（status 会初始化为空对象）
          counter = await context.resources.create<CounterSpec, CounterStatus>(
            COUNTER_RESOURCE_TYPE,
            {
              name: "main",
              spec: { enabled: true },
            },
          );
          // 首次创建后，立即初始化 status
          counter = await context.resources.patchStatus(counter, {
            totalTurns: 0,
            observedGeneration: 0,
          });
        }

        // 检查是否启用
        if (!counter.spec.enabled) return;

        const newTotal = reconcile.snapshot.turns.length;
        if (
          counter.status.totalTurns === newTotal &&
          counter.status.lastTurnId === turnResource.status.turnId
        ) {
          return;
        }

        await context.resources.patchStatus(counter, {
          totalTurns: newTotal,
          lastTurnId: turnResource.status.turnId,
          lastUserText: turnResource.status.userText?.slice(0, 50), // 只保存前50字符
          observedGeneration: counter.metadata.generation,
        });
      },
    });

    context.logger.info("Hello Counter activated", {
      component: "hello-counter.lifecycle",
    });
  },
});

export default helloCounter;
