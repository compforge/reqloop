# ReqLoop 长期方向

本文只承接尚未实现的方向，不能作为当前能力说明。当前事实见
[domain model](./domain-model.md)、[reconcile](./reconcile.md) 和
[integrations](./integrations.md)。

## 原始目标

ReqLoop 的长期目标是把一项需求从选择、开发、交付、部署、评估和修复推进到确认与关闭：

```text
Requirement
    → Development
    → Delivery
    → Deployment
    → Evaluation
    → Repair ─┐
         ▲    │
         └────┘
    → Confirm
    → Close
```

Baton 始终只提供通用控制面；Requirement Loop 的领域模型、推进策略、完成条件和平台适配归
ReqLoop。Harness 负责智能执行，devloop 约束 Harness 内的开发小闭环。

## 当前阶段

当前已落地：

- Requirement、Workspace、Repository、PullRequest、CodeReview 五种 Resource；
- 需求选择、Forge/devloop 观察、PR 与 Requirement 的持久关联；
- CodeReview 的 devloop 触发、Forge comment/finding label 收敛、review 决定、PR Board
  聚合和短期 TTL；
- Board/Context 投影和本地关闭确认；
- 用户显式删除期限与重启恢复。

当前未落地：

- Delivery、Deployment、Evaluation、Run/Attempt Resource；
- Requirement 目标仓库、环境和通用 CompletionPolicy；
- DevelopmentOutcome 等 Baton 归一事件；
- 外部 Requirement 更新/关闭、PR 合并、部署或评测写操作；
- Controller 主动选择并驱动 Harness；
- 第三方 Connector SDK、secret binding 和持久 cursor。

README、AGENTS 和当前设计文档不得把这些方向写成现有能力。

## 引入新概念的条件

新领域对象只有在身份、owner 和生命周期真实独立时才成为 Resource：

- Delivery 需要能稳定标识一次可部署交付物，并独立于 PR 生命周期；
- Deployment 需要区分目标环境、输入 Delivery、尝试状态和外部运行引用；
- Evaluation 需要有稳定 target/run identity，并对 CodeReview、Delivery 或 Deployment
  给出结构化 verdict 与证据；CodeReview 可以成为 Evaluation 的输入或证据，但二者不共用
  Resource 类型；
- Run/Attempt 只有在一项 Requirement 同时存在多个独立执行实例时才成立。

在这些条件出现前，继续使用现有 Resource status、`ctx.ask` 和 `ctx.draft`，避免为未来
预建空模型或第二套调度系统。

## 自动化演进

```text
Observe    读取外部事实并更新 Resource
Recommend  调用 draft 准备可编辑输入
Confirm    调用 ask 保存人的决定
Automate   在已授权 spec 下执行 Connector 写操作
Autonomous 真实场景证明需要后，再开放受控 Harness 调用
```

自动化提升的是某类动作在明确 scope 内的信任等级，不是绕过状态模型的总开关。任何外部
副作用都需要领域幂等键、最新观测、明确权限和可恢复结果。

## 待回答的问题

1. Completion Policy 需要哪些条件才能区分“尚未开发”和“开发完成且 PR 已收敛”？
2. Requirement 与目标仓库、环境、Delivery 的关系由谁拥有，查询键是什么？
3. DevelopmentOutcome 的最小稳定字段是什么，哪些事实应由 Baton 归一？
4. 多环境、租户和 credential/secret binding 如何进入 Connector 配置与权限 scope？
5. 哪些真实场景无法由 Resource 变化、cron 或 `requeueAfter` 覆盖，足以增加新的事件入口？
6. 哪些持久证据足以自动设置删除期限，且不会把一次 Source omission 误判为删除？
