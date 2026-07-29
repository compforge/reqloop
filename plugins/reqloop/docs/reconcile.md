# ReqLoop 准入与 Reconcile

## 主流程

ReqLoop 遵循同一条控制链：

```text
用户选择 / Source observation
              │
              ▼
       materialize Resource
              │
      Watch / cron / status change
              │
              ▼
       keyed reconcile queue
              │
              ▼
 Controller 读取最新 Resource 与必要外部事实
              │
              ├── patch status
              ├── derive Board / Context
              └── Interaction / proposed-input / toast
```

Source 负责集合准入，Watch 和 cron 只负责唤醒，Controller 只收敛已经存在的 Resource。
Connector 是外部查询能力，不创建或删除 Resource。重复发现同一稳定身份依靠 Baton Source
ensure 语义落到同一 Resource。

## Resource 如何进入系统

| Resource | 准入入口 | 边界 |
|---|---|---|
| Workspace | `WorkspaceSource` | 激活时贡献 Session 单例；文件变化只重新 emit 同一 spec |
| Repository | `WorkspaceRepositorySource` | 只扫描 Workspace 根和一级候选 checkout，并按稳定身份准入 |
| PullRequest | `ForgePullRequestSource`、`DevloopPullRequestSource` | Forge 列表有界且受活动策略控制；devloop 提供当前 PR 和 review 的低延迟入口 |
| Requirement | `/requirements` Command | 用户明确选择后读取详情并 upsert；Controller 不从列表结果自动创建 |

一次 Source 没有 emit 某个对象可能来自窗口、分页、权限或临时失败，因此 omission 不代表对象
已经退出或应该删除。

## Workspace 与 Repository

WorkspaceSource 观察工作区根、一级候选目录和已知 devloop PR 状态文件；watcher 失败只降低
实时性，WorkspaceController 仍可由初始 reconcile 与周期唤醒收敛。

WorkspaceController 重新发现 checkout，但只把已经准入的 Repository `ResourceRef` 和开放
PullRequest 数量投影到 Workspace status。Repository/PullRequest 的 create、update、delete
通过 Watch 唤醒同一 Workspace 单例。

RepositoryController Watches Workspace 和 PullRequest。它根据 Workspace 当前引用维护
`inScope`，并汇总已存在的 PullRequest 数量和 Connector 可用性；不会调用 Forge
`list()` 扩张 PR 集合。

## PullRequest

PullRequest 有两个并行发现入口：

1. `DevloopPullRequestSource` 读取 devloop 产出的当前 PR 与 review observation，缩短本地
   checkout 的发现路径；
2. `ForgePullRequestSource` 在活动策略允许时调用 `ForgeConnector.list()`，准入有界的开放
   PR/MR。

活动策略只决定 Forge 集合发现和观察频率，不改变 Resource 身份。写密集 checkout 使用高频
观察；缺少活动或以读取为主时不扩张集合，但已经准入的 PullRequest 仍以低频
`ForgeConnector.get()` 继续收敛。closed 和 review 已收敛的 merged PR 停止 Forge 观察；
review 尚未收敛的 merged PR 继续观察，作为 Requirement 收尾证据。具体时间窗口与间隔以
`devloop-activity.ts`、PullRequestController 和契约测试为准。

开放 PullRequest 若尚无归属决定且存在活跃 Requirement，PullRequestController 返回 durable
Interaction。Baton 先持久化回答，再重新 reconcile；Controller 随后把 linked 或 standalone
决定写入 status。取消或恢复使用稳定 decision key，不重复打扰用户。

Controller 还读取最新 devloop review observation。新的 actionable review 先询问 accept 或
ignore，并按 review key 记录一次最终决定；accept 返回 `proposed-input`，由用户审核或编辑后
再提交给当前 Harness，ignore 不驱动 Harness。

## Requirement

RequirementController 定期用与 identity.source 匹配的 RequirementConnector 读取外部需求。
成功观测更新状态和 `Observed=True`；失败写入 `Observed=False`，并在完成本地派生投影后把
错误交给 Baton 的重试机制。

PullRequest 的 create、update 和 delete 通过 Watch 映射到关联 Requirement。update 同时查看
old/new snapshot，因此 PR 改挂时旧、新两侧都重新汇总。RequirementController 扫描指向当前
Requirement uid 且未 closed 的 PullRequest，更新汇总和 `ReadyToClose`。

本地 PR 投影不依赖本次需求平台观察成功。达到 ReadyToClose 时 Controller 发送一次按 PR
revision 集合去重的 toast；当前不会关闭外部 Requirement，也不会返回开发任务的
`proposed-input`。

## 保留、删除与恢复

所有 Controller 都由 `withUserDeletionPolicy` 包装。用户可以通过
`reqloop.baton.dev/delete-after` annotation 给出 ISO 绝对删除期限：

- 未到期时保留更早的领域 requeue，并安排删除期限；
- 到期后请求 Baton 删除；
- 进入 `deletionTimestamp` 后继续委托原 Controller 完成 terminating cleanup。

没有自动 terminal TTL、lease 或 last-seen GC。离开 Workspace、进入 terminal 和 Board 隐藏
只改变观察或展示，不自动设置期限。

Resource status、durable Interaction 和下一次调度均可跨重启恢复。Controller 不把触发原因
当作必须执行一次的命令；重复唤醒、队列合并和重启后都重新读取最新状态，以幂等结果为目标。
