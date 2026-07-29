import type {
  BatonTurnResourceData,
  PluginPackage,
  PluginActivationContext,
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
  pluginId: "qiankunli/hello-counter",
  version: "0.1.0",

  async activate(context: PluginActivationContext): Promise<void> {
    // 1. 注册 CounterState Resource Controller
    context.registerController<CounterSpec, CounterStatus>({
      resourceType: COUNTER_RESOURCE_TYPE,
      async reconcile(_baton, resource) {
        console.log(
          `[hello-counter] Reconciling CounterState: generation=${resource.metadata.generation}, totalTurns=${resource.status?.totalTurns || 0}`,
        );

        // 如果未启用，不做任何操作
        if (!resource.spec.enabled) {
          console.log("[hello-counter] Counter is disabled");
          return {};
        }

        // 正常情况下，这里什么都不做，因为实际计数由 baton.turn Controller 触发
        return {};
      },
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
    context.registerController<Record<string, never>, BatonTurnResourceData>({
      resourceType: BATON_TURN_RESOURCE_TYPE,
      async reconcile(_baton, turnResource) {
        console.log(
          `[hello-counter] Turn detected: ${turnResource.status.turnId}`,
        );

        // 查找或创建 CounterState
        const counterList = await context.resources.list<
          CounterSpec,
          CounterStatus
        >(COUNTER_RESOURCE_TYPE);

        let counter = counterList.find((c) => c.metadata.name === "main");

        if (!counter) {
          // 第一次：创建 CounterState（status 会初始化为空对象）
          console.log("[hello-counter] Creating initial CounterState");
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
        if (!counter.spec.enabled) {
          console.log("[hello-counter] Counter is disabled, skipping");
          return {};
        }

        // 更新计数
        const newTotal = (counter.status?.totalTurns || 0) + 1;
        console.log(`[hello-counter] Updating count: ${newTotal}`);

        counter = await context.resources.patchStatus(counter, {
          totalTurns: newTotal,
          lastTurnId: turnResource.status.turnId,
          lastUserText: turnResource.status.userText?.slice(0, 50), // 只保存前50字符
          observedGeneration: counter.metadata.generation,
        });

        // 返回 proposed-input 建议
        return {
          output: {
            kind: "proposed-input",
            text: `📊 统计：你已经问了 ${newTotal} 个问题。最近一次：${turnResource.status.userText?.slice(0, 30)}...`,
          },
        };
      },
    });

    console.log("[hello-counter] Plugin activated successfully");
  },
});

export default helloCounter;
