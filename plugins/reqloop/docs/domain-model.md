# ReqLoop 领域模型

本文只描述 `compforge/reqloop` 当前已经实现的领域模型。具体字段以各领域目录的
`protocol.ts` 为事实来源；尚未落地的 Delivery、Deployment、Evaluation 和主动 Harness
执行见 [roadmap](./roadmap.md)。

## 理念与概念

ReqLoop 把外部需求、工作区、代码仓库和 PR/MR 映射为 BatonSession 内可持续 reconcile 的
Resource。外部平台继续拥有外部事实，Baton Resource 保存当前需求契约、观测和用户决定，
Board 与 Context 只提供派生读模型。

当前有五种 Resource：

| Resource | 稳定身份 | owner 与职责 | Board |
|---|---|---|---|
| `Workspace` | 当前 PluginInstance namespace 内的单例 | 表示 BatonSession cwd 的逻辑观察边界，投影已准入仓库和开放 PR 数量 | 不展示 |
| `Repository` | `source + repository` | 表示一个 Forge 仓库是否仍在观察范围，以及已经存在多少 PullRequest | 不展示 |
| `PullRequest` | `source + repository + number` | 保存 Forge 生命周期、review/merge blocker 和 Requirement 归属决定 | 展示未关联的开放 PR；绑定待标注 CR 时延长展示 |
| `CodeReview` | `pullRequest + runKey` | 保存一次已发布 AI review run 的 revision、结果、finding label、决定和有效期 | 绑定 PR 时随 PR 展示；找不到 PR 时独立展示 |
| `Requirement` | `source + category + id` | 保存用户选中的需求契约、需求平台观测和关联 PR 的派生汇总 | 展示未关闭的需求 |

`source` 是具名 Connector 的稳定配置键。GitHub/GitLab、Meego 等 provider 信息停留在
Connector 侧，不进入通用身份分支。

## 关系与事实归属

```text
BatonSession cwd
      │
      ▼
  Workspace ──projects──▶ Repository ──groups──▶ PullRequest
                                                    ├──reviewed-by──▶ CodeReview
                                      association   │ 0..1
                                                    ▼
                                               Requirement
```

Workspace 是发现和投影的逻辑根，不是 Baton `metadata.owner`。Repository、PullRequest、
CodeReview 和 Requirement 都能独立保留，因此删除 Workspace 不级联删除它们。PR merged
也不结束已存在的 CodeReview；CodeReview 按 finding label、用户决定与自身期限收口。

一份 PullRequest 最多关联一份 Requirement，也可以明确保持 standalone。关联事实只保存在
`PullRequest.status.requirementAssociation`：

- 字段缺失表示尚无归属决定；
- `prompted` 表示用户关闭了归属问题或等待超时，Controller 不自动重复询问；
- `linked` 保存带 `namespace/name/uid` 的 Requirement `ResourceRef`；
- `standalone` 表示用户明确选择独立跟踪。

Requirement 不保存实际 PR 列表，只在 reconcile 时扫描仍指向自己当前 uid 的 PullRequest，
生成 `linkedPullRequests` 汇总。Requirement 被删除并以同名 Resource 重建后，新 uid 不会
继承旧关联。

## Spec、Status 与 Conditions

Requirement `spec` 保存用户选中时认可的标题、描述和验收标准；`status` 保存需求平台当前
状态、关联 PR 汇总和条件。PullRequest `spec` 只保存不可变外部身份；Forge 观测和归属决定
进入不同的 status 字段，互不覆盖。merge conflict 的用户决定按一次连续冲突 episode 保存；
接受后终结的 Harness Turn id 也记录在同一 episode，避免重复打开 draft，但不代表冲突已经解决；
冲突消失后清空，避免旧决定压住未来再次出现的冲突。

CodeReview `spec` 保存目标 PullRequest、一次运行的稳定 `runKey` 和被冻结的 revision；
`status` 保存 phase、verdict、结构化结果、finding 证据、人的决定与期限。当前以 devloop
发布到 Forge 的 summary comment id 作为 `runKey`，findings 来自同一轮 summary 之前带
`ccr:fp` marker 的 review comments；comment 内第一个有效 `ccr:label` reply 是该 finding
的处理标记。没有发布 comment 的 clean review 不产生 CodeReview。

Requirement 在 `ReadyToClose=True` 时按自身 generation 与关联 PullRequest revision 集合保存一次
closure decision。保持打开、关闭 Interaction 或等待超时都会保留为当前事实集合的 defer；只有
集合变化后才再次询问。

Requirement 当前使用三个 condition：

- `Observed`：最近一次 RequirementConnector 观察是否成功；
- `ReadyToClose`：关联 PR 是否满足当前收尾条件；
- `ClosureRequested`：用户是否确认结束 reqloop 对该 Requirement 的本地跟踪。

Conditions 是当前谓词，不是事件历史。只有 `True / False / Unknown` 迁移才更新 transition
time；reason、message 或 observed generation 的刷新不伪造状态迁移。

当前 `ReadyToClose` 规则要求至少有一份关联 PR，且全部已 merged、没有 merge conflict，
review thread 均为 none 或 resolved。无法观察 review thread 时为 `Unknown`，不能乐观关闭。
达到该条件后，RequirementController 通过 durable Interaction 询问用户；确认会写入
`ClosureRequested=True` 并给出 toast，但不修改外部需求状态。

## Board 投影

Board 当前展示活跃 Requirement 和需要关注的 PullRequest。actionable CodeReview 能匹配
PullRequest Resource 时，其数量与 finding label 进度聚合到 PR 卡片，不再占第二个槽位；
找不到 PR 时才降级为独立卡片。accept 只停止重复提醒，CR 保持可见直到全部可标注 finding
完成 label；关闭或超时的 Interaction 降级为 ignore 并立即隐藏。

merge conflict 和 unresolved review 是当前 blocker：它们影响卡片 tone，并提高 Board
priority，使阻塞项优先进入 Baton 的有限展示集合。未标注 CR 可以让 merged PR 延长 Board
候选资格，但处于低优先级；容量不足时仍会被 open merge conflict 等活跃阻塞项挤出。具体
分值属于当前实现细节，以 Controller 及其测试为准。

Board 隐藏只影响展示。merged/closed、Requirement completed/closed、用户确认本地关闭、
Repository 离开范围，都不会因此删除对应 Resource。`ClosureRequested` 还会让 Requirement
退出 Context 搜索和后续 PR 关联候选，避免已经结束的本地生命周期再次进入工作流。
CodeReview 是有界短期对象：即使用户不处理，也会在自身期限到达后删除。
