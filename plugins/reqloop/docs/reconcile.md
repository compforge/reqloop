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
              └── ctx.ask / ctx.draft / toast
```

Source 负责集合准入，Watch 和 cron 只负责唤醒，Controller 只收敛已经存在的 Resource。
Connector 是外部查询能力，不创建或删除 Resource。重复发现同一稳定身份依靠 Baton Source
ensure 语义落到同一 Resource。

## Resource 如何进入系统

| Resource | 准入入口 | 边界 |
|---|---|---|
| Workspace | `WorkspaceSource` | 激活时贡献 Session 单例；文件变化只重新 emit 同一 spec |
| Repository | `WorkspaceRepositorySource` | 只扫描 Workspace 根和一级候选 checkout，并按稳定身份准入 |
| PullRequest | `ForgePullRequestSource`、`DevloopPullRequestSource` | Forge 列表有界且受活动策略控制；devloop 提供当前 PR 的低延迟入口 |
| CodeReview | `DevloopCodeReviewSource`、`ForgeCodeReviewSource` | devloop history 低延迟触发；Forge comments 准入仍在有效期内的已发布 actionable AI review |
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

1. `DevloopPullRequestSource` 读取 devloop 产出的当前 PR，缩短本地 checkout 的发现路径；
2. `ForgePullRequestSource` 在活动策略允许时调用 `ForgeConnector.list()`，准入有界的开放
   PR/MR。

活动策略只决定 Forge 集合发现和观察频率，不改变 Resource 身份。写密集 checkout 使用高频
观察；缺少活动或以读取为主时不扩张集合，但已经准入的 PullRequest 仍以低频
`ForgeConnector.get()` 继续收敛。closed PR 停止 Forge 观察；merged PR 的 review thread
仍可继续作为 Requirement 收尾证据。具体时间窗口与间隔以 `devloop-activity.ts`、
PullRequestController 和契约测试为准。

开放 PullRequest 若尚无归属决定且存在活跃 Requirement，PullRequestController 调用 `ctx.ask`。
Baton 先持久化 Interaction，再挂起当前 async reconcile；回答、关闭或超时后恢复同一调用栈。
Controller 重新读取同一 Resource incarnation，再把 linked、standalone 或 prompted 决定写入
status。prompted 表示用户关闭了问题或等待超时，后续 reconcile 不自动重复打扰。

开放 PR/MR 出现 merge conflict 时，Controller 同样调用 `ctx.ask`。每次连续冲突
只询问一次；accept 随后 await `ctx.draft`，由用户编辑并提交解决冲突的输入，ignore 不创建
draft。终结的 follow-up Turn id 写入当前 decision episode 以防重复，但不代替 Forge 结果观测；
关闭或超时则降级为 ignore；冲突状态消失后结束本次 episode，未来再次冲突时重新询问。

## CodeReview

devloop 的 `review` 是可配置到 lifecycle phase 的异步 signal hook：配置在
`pre/post_commit` 时，每次成功 commit 触发；配置在 `post_mr` 时，每次 gcampr/publish
触发。每次后台运行启动时冻结 branch 和 SHA，评审 `origin/<target>..<SHA>` 的整条分支改动，
而不是只评最后一个 commit。

`DevloopCodeReviewSource` 监听各 checkout 的 `review-history.jsonl`，但只把文件变化当成
低延迟信号，随即要求 Forge Source 重新发现；`ForgeCodeReviewSource` 的周期扫描承担恢复
兜底。Forge Source 扫描已经准入且未 closed 的有限数量 PullRequest，通过匹配 source 的
`ForgeConnector.comments()` 读取 conversation 与 diff comments。devloop summary marker
标识一次独立 CodeReview run，summary comment id 成为 `runKey`；带 `ccr:fp` marker 的
review comments 作为结构化 findings。Source 会准入 TTL 内每一轮已发布结果，而不只恢复
最新一轮；同一 revision 的重跑也因 `runKey` 不同而保持独立。clean review 不发布 Forge
comment，因此也不产生当前 CodeReview。

CodeReviewController 按 `runKey` 重新读取同一轮 Forge comments 并物化 terminal status。
actionable 结果通过 `ctx.ask` 请求 accept/ignore：accept 随后 await `ctx.draft`，由用户编辑并
提交供当前 Harness 审核的输入，要求用 devloop label-review 给每个 finding thread 写入
`ccr:label`；终结的 follow-up Turn id 写入 status，关闭或超时降级为 ignore；
Controller 周期刷新 comments 并汇总 label 进度。ignore 不驱动 Harness。二者都只代表用户
如何处理建议，不改变 review verdict。CodeReview 与 PR 生命周期独立，因此 PR merged 后
仍可继续存在。

Board projection 优先把待处理 CodeReview 聚合到匹配的 PullRequest 卡片，并由 CodeReview
Watch 唤醒该 PR 刷新；只有找不到 PR Resource 时才显示独立 CR 卡片。accept 只停止重复
提醒，全部可标注 finding 完成 label 后才隐藏；ignore 立即隐藏。未标注 CR 可让 merged PR
继续成为 Board 候选，但其优先级低于 open merge conflict 等活跃阻塞项，Board 容量不足时
可以不展示。

AI code review 是短期建议。CodeReview 创建后按评审完成时间计算固定期限；Resource 保留到
期限，避免 Source 在每次 Forge 轮询时重新准入同一 comment；到期后 Controller 删除它。
无人处理时也按同一期限自行消亡。

## Requirement

RequirementController 定期用与 identity.source 匹配的 RequirementConnector 读取外部需求。
成功观测更新状态和 `Observed=True`；失败写入 `Observed=False`，并在完成本地派生投影后把
错误交给 Baton 的重试机制。

PullRequest 的 create、update 和 delete 通过 Watch 映射到关联 Requirement。update 同时查看
old/new snapshot，因此 PR 改挂时旧、新两侧都重新汇总。RequirementController 扫描指向当前
Requirement uid 且未 closed 的 PullRequest，更新汇总和 `ReadyToClose`。

本地 PR 投影不依赖本次需求平台观察成功。达到 ReadyToClose 时 Controller 以 Requirement
generation 与当前 PR revision 集合作为 decision basis，调用 `ctx.ask` 询问用户是否结束本地
跟踪。用户确认后写入 `ClosureRequested=True` 并发送成功 toast；保持打开、关闭或超时会保存
defer，直到关联 PR revision 集合发生变化。Requirement 关闭后随即退出 Board、Context 搜索和
PR 关联候选。
当前不会关闭外部 Requirement，也不会创建开发任务的 draft。

## 保留、删除与恢复

所有 Controller 都由 `withUserDeletionPolicy` 包装。用户可以通过
`reqloop.baton.dev/delete-after` annotation 给出 ISO 绝对删除期限：

- 未到期时保留更早的领域 requeue，并安排删除期限；
- 到期后请求 Baton 删除；
- 进入 `deletionTimestamp` 后继续委托原 Controller 完成 terminating cleanup。

Workspace、Repository、PullRequest 和 Requirement 没有自动 terminal TTL、lease 或
last-seen GC。离开 Workspace、进入 terminal 和 Board 隐藏只改变观察或展示，不自动设置
期限。CodeReview 还具有固定的领域 TTL；它不从 Source omission 推断，也不
影响用户显式删除期限。

Resource status、durable Interaction 和下一次调度均可跨重启恢复；正在等待 verb 的进程内
continuation 不重放，Runner/Core 中断以 failure 收口，后续 reconcile 只依据领域 status 决定
是否重试。Controller 在 verb 返回后重新读取当前 Resource incarnation，不使用等待前的
resourceVersion 写入。Controller 不把触发原因当作必须执行一次的命令；重复唤醒、队列合并和
重启后都重新读取最新状态，以幂等结果为目标。
恢复时 Repository / PullRequest Resource JSON 同时充当最后观测缓存；Board 和本地汇总直接
从缓存恢复。外部 Connector 调用应围绕 observation 缺失、刷新窗口到期或新对象发现等实际
需要安排，避免仅因恢复或重建投影而访问外部 API。具体约束见
[集成边界](./integrations.md#缓存与外部调用)。
