import type {
  PluginPackage,
  PluginActivationContext,
} from "@baton/plugin";

interface CounterSpec {
  enabled: boolean;
}

interface CounterStatus {
  totalTurns: number;
  lastTurnId?: string;
  lastUserText?: string;
  observedGeneration: number;
}

const helloCounter: PluginPackage = Object.freeze({
  pluginId: "qiankunli/hello-counter",
  version: "0.1.0",

  async activate(context: PluginActivationContext): Promise<void> {
    // 1. 注册 CounterState PluginResource
    context.registerResource<CounterSpec, CounterStatus>({
      resourceKind: "CounterState",
      reconciler: {
        async reconcile(baton, resource) {
          console.log(
            `[hello-counter] Reconciling CounterState: generation=${resource.metadata.generation}, totalTurns=${resource.status?.totalTurns || 0}`,
          );

          // 如果未启用，不做任何操作
          if (!resource.spec.enabled) {
            console.log("[hello-counter] Counter is disabled");
            return {};
          }

          // 正常情况下，这里什么都不做，因为实际计数由 baton.turn watch 触发
          return {};
        },
      },
    });

    // 2. Watch baton.turn，每次用户提问时更新计数
    context.watchBuiltinResource({
      resourceKind: "baton.turn",
      reconciler: {
        async reconcile(baton, turnResource) {
          console.log(
            `[hello-counter] Turn detected: ${turnResource.data.turnId}`,
          );

          // 查找或创建 CounterState
          const counterList = await context.resources.list<
            CounterSpec,
            CounterStatus
          >("CounterState");

          let counter = counterList.find((c) => c.metadata.resourceId === "main");

          if (!counter) {
            // 第一次：创建 CounterState
            console.log("[hello-counter] Creating initial CounterState");
            counter = await context.resources.create<CounterSpec, CounterStatus>(
              "CounterState",
              {
                resourceId: "main",
                spec: { enabled: true },
                status: {
                  totalTurns: 0,
                  observedGeneration: 0,
                },
              },
            );
          }

          // 检查是否启用
          if (!counter.spec.enabled) {
            console.log("[hello-counter] Counter is disabled, skipping");
            return {};
          }

          // 更新计数
          const newTotal = (counter.status?.totalTurns || 0) + 1;
          console.log(`[hello-counter] Updating count: ${newTotal}`);

          await context.resources.patchStatus<CounterSpec, CounterStatus>(
            "CounterState",
            "main",
            {
              totalTurns: newTotal,
              lastTurnId: turnResource.data.turnId,
              lastUserText: turnResource.data.userText?.slice(0, 50), // 只保存前50字符
              observedGeneration: counter.metadata.generation,
            },
          );

          // 返回 proposed-input 建议
          return {
            output: {
              kind: "proposed-input",
              text: `📊 统计：你已经问了 ${newTotal} 个问题。最近一次：${turnResource.data.userText?.slice(0, 30)}...`,
            },
          };
        },
      },
    });

    console.log("[hello-counter] Plugin activated successfully");
  },
});

export default helloCounter;
