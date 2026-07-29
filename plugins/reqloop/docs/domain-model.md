# ReqLoop 领域模型

本文只描述 `compforge/reqloop` 当前已经实现的领域模型。具体字段以各领域目录的
`protocol.ts` 为事实来源；尚未落地的 Delivery、Deployment、Evaluation 和主动 Harness
执行见 [roadmap](./roadmap.md)。

## 理念与概念

ReqLoop 把外部需求、工作区、代码仓库和 PR/MR 映射为 BatonSession 内可持续 reconcile 的
Resource。外部平台继续拥有外部事实，Baton Resource 保存当前需求契约、观测和用户决定，
Board 与 Context 只提供派生读模型。

当前有四种 Resource：

| Resource | 稳定身份 | owner 与职责 | Board |
|---|---|---|---|
| `Workspace` | 当前 PluginInstance namespace 内的单例 | 表示 BatonSession cwd 的逻辑观察边界，投影已准入仓库和开放 PR 数量 | 不展示 |
| `Repository` | `source + repository` | 表示一个 Forge 仓库是否仍在观察范围，以及已经存在多少 PullRequest | 不展示 |
| `PullRequest` | `source + repository + number` | 保存 Forge 生命周期、review/merge blocker、devloop review 观测和 Requirement 归属决定 | 只展示未关联的开放 PR |
| `Requirement` | `source + category + id` | 保存用户选中的需求契约、需求平台观测和关联 PR 的派生汇总 | 展示未关闭的需求 |

`source` 是具名 Connector 的稳定配置键。GitHub/GitLab、Meego 等 provider 信息停留在
Connector 侧，不进入通用身份分支。

## 关系与事实归属

```text
BatonSession cwd
      │
      ▼
  Workspace ──projects──▶ Repository ──groups──▶ PullRequest
                                                    │
                                      association   │ 0..1
                                                    ▼
                                               Requirement
```

Workspace 是发现和投影的逻辑根，不是 Baton `metadata.owner`。Repository、PullRequest 和
Requirement 都能独立保留，因此删除 Workspace 不级联删除它们。

一份 PullRequest 最多关联一份 Requirement，也可以明确保持 standalone。关联事实只保存在
`PullRequest.status.requirementAssociation`：

- 字段缺失表示尚无归属决定；
- `prompted` 保留已询问或恢复中的 durable decision key；
- `linked` 保存带 `namespace/name/uid` 的 Requirement `ResourceRef`；
- `standalone` 表示用户明确选择独立跟踪。

Requirement 不保存实际 PR 列表，只在 reconcile 时扫描仍指向自己当前 uid 的 PullRequest，
生成 `linkedPullRequests` 汇总。Requirement 被删除并以同名 Resource 重建后，新 uid 不会
继承旧关联。

## Spec、Status 与 Conditions

Requirement `spec` 保存用户选中时认可的标题、描述和验收标准；`status` 保存需求平台当前
状态、关联 PR 汇总和条件。PullRequest `spec` 只保存不可变外部身份；Forge 观测、归属决定和
devloop review 结果都进入不同的 status 字段，互不覆盖。

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

Board 当前只展示活跃 Requirement 和未关联的开放 PullRequest。关联后 PullRequest 仍是独立
Resource，只是不再重复占据顶层卡片。

merge conflict 和 unresolved review 是当前 blocker：它们影响卡片 tone，并提高 Board
priority，使阻塞项优先进入 Baton 的有限展示集合。具体分值属于当前实现细节，以 Controller
及其测试为准。

Board 隐藏只影响展示。merged/closed、Requirement completed/closed、用户确认本地关闭、
Repository 离开范围，都不会因此删除对应 Resource。`ClosureRequested` 还会让 Requirement
退出 Context 搜索和后续 PR 关联候选，避免已经结束的本地生命周期再次进入工作流。
