# reqloop：Requirement Loop Plugin 设计

> 状态：讨论草案。reqloop 是独立交付的 Requirement Loop Marketplace / Plugin。本文只描述
> reqloop 的领域与内部边界；Baton 的通用
> Plugin、Resource 和 Reconcile 契约见
> [Baton Plugin 设计](https://github.com/compforge/baton/blob/main/docs/plugin.md)，整体控制面
> 见 [Loop Engineering](https://github.com/compforge/baton/blob/main/docs/loop-engineering.md)。

## 1. 定位与边界

reqloop 把一项需求从选择、开发、部署、review、修复推进到验收和关闭：

```text
Requirement
    → Development
    → Deployment
    → Evaluation
    → Repair ─┐
         ▲    │
         └────┘
    → Confirm
    → Close
```

它解决两个问题：

1. Baton 是通用控制面，单独交付时用户不容易立即理解可以组装什么；
2. Requirement Loop 需要稳定领域模型，但不能绑定 Meego、Teambition、某个部署平台或某种
   review 系统。

因此采用两层边界：

- **Baton**：只提供 Plugin host、Harness、事件、调度、权限、Board 和 Context；
- **reqloop**：拥有 Requirement Loop 的领域模型、推进策略、完成条件与平台适配。

reqloop 作为独立 Package 通过 reqloop Marketplace 发布，不是 Baton core：

- 可以禁用、替换和独立升级；
- 未配置时 `/requirements` 提供引导，不要求 Baton core 理解需求字段；
- reqloop 的连接参数进入 PluginInstance config；Connector cursor、缓存等私有状态进入 Baton
  注入的 reqloop data 目录，不写不可变 Package，也不冒充 Requirement Resource；
- Baton 不导入 reqloop 类型，不根据 Requirement 状态写分支。

## 2. 核心概念

### Requirement

`Requirement` 是 reqloop 的业务锚点，也是承载 Requirement Loop 状态的 Resource。用户从外部
需求系统选中一项需求后，reqloop 以其中立 identity 创建或恢复同一份 Requirement Resource，
并用 `spec/status` 分开期望和观测：

```text
Requirement
├── spec
│   ├── identity          source + category + id
│   ├── title / description
│   ├── acceptance        验收目标
│   ├── repositories      目标仓库
│   ├── environments      目标环境
│   └── completionPolicy  完成条件，例如不存在活跃 PR/MR
└── status
    ├── externalState     外部需求系统的当前观测
    ├── deliveries        artifact 等其它实际交付
    ├── deployments
    ├── evaluations       review / e2e / eval / perf
    ├── harnessResults
    ├── linkedPullRequests 关联 PR 的 Board 汇总
    ├── conditions
    └── observedGeneration
```

Requirement、验收目标和完成策略属于用户认可的 Contract；PR、部署、review 和 Harness 结果
是实际产出。RequirementConnector 把 Meego、Teambition 等外部对象归一为这个模型；外部平台
状态进入 `status.externalState`，不直接充当 reqloop 内部状态机。Harness 可以建议修改
Requirement，但只有用户认可后才更新 `spec`。

`status.conditions` 使用 Baton Plugin API 的可选 Kubernetes 风格 wire shape，并由 reqloop
解释领域语义。`Observed` 表示最近一次 RequirementConnector 观测是否成功；
`ReadyToClose` 汇总关联 PullRequest 是否已满足当前收尾条件。每个 type 只保留当前一条记录，
只有 `True / False / Unknown` 迁移才更新 `lastTransitionTime`；reason、message 或
observedGeneration 刷新不伪造新迁移。Conditions 是当前谓词，不是事件历史，也不取代
externalState 或后续 completion policy。

重开、重试或多环境验收先表达为同一 Requirement 的状态演进。只有真实出现“一项 Requirement
必须同时拥有多个独立执行实例”的需求时，才引入 Run / Attempt 概念。

PR/MR 不写入 Requirement `spec`：它们是否出现、关联到哪个 Requirement、当前是否终止，
都是执行过程中形成的事实。关联决定保存在 PullRequest status，Requirement 侧按 ResourceRef
派生汇总，避免双写。`completionPolicy` 只表达期望，
例如“没有关联 PR/MR，或所有已关联 PR/MR 均已 merged”。这个条件只说明 PR/MR
不再阻塞收尾；初始状态同样没有 PR/MR，因此仍须与开发结果、验收等条件组合，不能单独让新建
Requirement 立即进入可关闭状态。

### Workspace

`Workspace` 是 reqloop 在一个 BatonSession 内的本地观察边界。它以 Baton 启动目录为根，
负责发现进入当前 session 观察范围的仓库；它不是 Git 仓库本身，也不把 workspace 或 repository
概念下沉到 Baton core。

```text
Workspace
├── spec
│   └── root              session-cwd
└── status
    ├── repositories      Repository ResourceRef + 相对路径
    ├── observedAt
    └── discoveryErrors
```

Workspace 在 PluginInstance namespace 内是单例。`spec.root` 表达“使用当前 BatonSession
cwd”的稳定语义，不持久化机器相关的绝对路径；发现结果只保存相对路径和 ResourceRef。同一模型
同时覆盖两种启动方式：在单仓根目录启动时发现根仓库，在聚合目录启动时发现其一级子目录中的多个
仓库。

Workspace 仍配置 `WorkspaceSource`。它在激活时贡献单例 Workspace，
并监听根目录、一级候选目录以及已知 `.devloop/pr.json` 的变化；变化发生时只重新 emit 同一份
Workspace spec，使主 Resource 进入 keyed reconcile queue。`WorkspaceController` 随后重新读取
文件系统，并把已经由 Repository/PullRequest Source 准入的 Resource 投影进 Workspace status；
它不创建其它 Resource。Repository/PullRequest 的 create、update、delete 通过 Watch 立即重投影；
固定周期的 cron Source 仍作为投影完整性的兜底。

首版扫描必须有界：只检查 workspace 根目录自身，以及一级子目录和一级符号链接指向的目录，
不做无上限递归。WorkspaceSource 提供低延迟感知，不是语义上的必需依赖；即使 watcher 不可用，
Controller 仍可依靠首次 reconcile 和 cron 重扫收敛，只是发现延迟更高。

### Repository

`Repository` 是 PR/MR 集合发现的长期观察锚点。它按 `source + repository` 唯一标识一个
外部仓库，由多项 Requirement 共享，而不是每创建一项 Requirement 就复制一份：

```text
Repository
├── spec
│   └── identity          Forge source + repository
└── status
    ├── connectorAvailable
    └── discoveredPullRequests
```

创建条件是“仓库进入 reqloop 的观察范围”。`ForgeRepositorySource` 对有界 Workspace
checkout 执行准入并按稳定 identity emit Repository，`DevloopRepositorySource` 可以更快贡献
当前 checkout；未来 Requirement 支持 `repositoryRefs` 后，对应 Source 同样可以贡献目标仓库。
多个发现入口指向同一仓库时复用同一 Resource；发现 PR/MR 或创建 Requirement 本身都不是新建
Repository 的理由。
RepositoryController Watches Workspace 的旧、新成员引用；默认 Workspace 入口不再引用某个
Repository 时，将其标记为离开观察范围，重新进入时复用原 Resource。Workspace 与 Repository
都是内部观察和聚合 Resource，`present()` 固定返回空，不进入 Board。

`DevloopPullRequestSource` 读取 `.devloop/pr.json`，作为当前 PR 的本地低延迟入口；
`ForgePullRequestSource` 周期性调用 `ForgeConnector.list()`，按自己的有界准入策略贡献近期开放
PR/MR。RepositoryController 只汇总已经存在的 PullRequest，不调用 Connector 扩张集合；逐
PullRequest 的外部状态仍由 PullRequestController 通过 `get()` 收敛。

### PullRequest

`PullRequest` 是 reqloop 自己的一种 Resource，统一表示 GitHub Pull Request 和 GitLab Merge
Request。它拥有独立外部身份和观察生命周期，可以先于 Requirement 被发现，也可以被一个或
多个 Requirement 引用：

```text
PullRequest
├── spec
│   └── identity          Forge source + repository + number
└── status
    ├── title / url       Forge 展示标题与可打开地址
    ├── lifecycle         open / merged / closed
    ├── reviewThreads     none / unresolved / resolved / unknown
    ├── reviewActivityKey review thread/comment 集合的外部活动指纹
    ├── mergeability      ready / conflicted / unknown
    ├── requirementAssociation
    │   └── prompted / linked(requirement ref) / standalone
    ├── review            devloop review key / status / sha / counts
    ├── reviewDecision    review key + accept / ignore
    └── observedAt
```

reqloop 关心的是 Requirement Loop 是否仍被 PR/MR 上的未解决 review thread 或 merge conflict
阻塞，以及 PR/MR 是否已经终止；它不拥有 branch、worktree、head/base、commit、push 或 lint/test
生命周期。普通 conversation comment 在部分 Forge 上没有 resolved 语义，因此跨平台状态只对
可解析的 review thread / discussion 声称 resolved，不能把“存在 comment”直接解释成待处理。

这与 devloop 的 `PullRequest` 关注点不同：devloop 用它管理开发分支、提交、验证和创建/更新
PR/MR 的小闭环；reqloop 用独立 Resource 观察需求级收尾条件。两者可以对齐
`repository + number + lifecycle` 等外部身份语义，但不共享运行态或互相导入领域类型。

一份 PullRequest 最多关联一个 Requirement，也可以保持独立。关联只以
`PullRequest.status.requirementAssociation` 为事实源；Requirement 不反向保存列表，需要汇总时
由 Requirement reconcile 扫描当前 PullRequest Resources。Requirement Controller 在 PullRequest
上声明 Watches，EventHandler 把 create / update / delete 映射为关联 Requirement 的
`ReconcileRequest`；update 同时映射 old / new 关联，因此改挂时两边都能重新汇总，delete 使用
最后一份快照移除旧汇总。Watch 只负责路由，不成为关联事实或派生索引。关联保存包含
`namespace/name/uid` 的完整 ResourceRef，Requirement 重建后不会继承旧 incarnation 的 PR。
关联问题只询问一次：
字段缺失表示 status 尚无归属决定，Controller 仍会先检查 Baton 的 durable Interaction；
`prompted` 保留取消或恢复中的 decision key，`linked` 保存 Requirement ResourceRef，
`standalone` 表示用户明确选择独立跟踪。即使
Interaction 被取消，Baton 的持久决议和随后写入的 `prompted` 也会阻止系统重复打扰用户。
Controller 只有看到 Baton 已持久化的 Interaction snapshot 后才写最终决定；如果 status 已是
`prompted` 但 Interaction 尚未落盘，则幂等返回同一 `decisionKey`，避免崩溃窗口丢失问题。
PullRequestController 还 Watches Requirement 从非活跃变为活跃，把尚待关联的开放 PR 重新入队。

Board 当前只展示活跃 Requirement 和尚未关联的活跃 PullRequest。PullRequest 关联 Requirement
后仍保持独立 Resource 和生命周期，但 Board 以 Requirement 为主，不再重复生成 PR 卡片；
Requirement status 汇总关联 PR 的 lifecycle、merge conflict 和 unresolved review thread。
PullRequest 卡片用 Resource Type 的首个 `shortNames` 别名 `pr` 作为分组标题，第一行展示
repository/number 与状态，第二行展示 Forge title；title 超出 Sidecar 横向空间时才滚动。
卡片 title 是指向 Forge `url` 的终端原生超链接。
merged 和 closed 的 PullRequest 都从 Board 消失；closed 与 review 状态已收敛的 merged
PullRequest 停止轮询，review 状态尚未满足 Requirement 收尾条件的 merged PullRequest 继续观察。

### Resource 的创建、保留与销毁（当前阶段）

外部对象是否存在、内部 Resource 是否存储、Board 是否展示是三件事。reqloop 当前已经把
“谁能让外部对象成为 Resource”收口到显式 Command 和 Source，也已经可以使用 Baton 的通用
terminating 删除流程。用户还可以为任一 reqloop Resource 设置绝对删除期限 annotation
`reqloop.baton.dev/delete-after`；除此之外不启用默认 retention / GC，不能把“隐藏”写成“销毁”。

| Resource | 进入系统 | 活跃期收敛 | 当前退出行为 |
|---|---|---|---|
| Workspace | `WorkspaceSource` 为当前 session emit 单例 | `WorkspaceController` 重扫本地范围并投影已准入对象；不进入 Board | 默认保留；设置 `delete-after` 后到期删除 |
| Repository | `ForgeRepositorySource` 与 `DevloopRepositorySource` 按稳定 identity 准入 | `RepositoryController` 汇总已存在 PR 并维护 `inScope`；不进入 Board | 离开 workspace 时设为 `inScope=false`；默认保留，可设置期限 |
| PullRequest | `ForgePullRequestSource` 与 `DevloopPullRequestSource` 各自按有界策略准入 | `PullRequestController` 用 `ForgeConnector.get()` 与 review observation 更新 status | merged / closed 后从 Board 隐藏并按现有条件停止轮询；默认保留，可设置期限 |
| Requirement | 用户通过 `/requirements` 明确选择后由 Command 创建或恢复 | `RequirementController` 观察外部需求并汇总关联 PR | completed / closed 后从 Board 隐藏；默认保留，可设置期限 |

```text
外部对象
   │ 用户选择 / Source 准入
   ▼
Active Resource ── present() 返回卡片 ── Board 可见
   │
   ├── 离开范围或进入 terminal
   │       └── Board 隐藏，Resource 仍存在并可被重新使用
   │
   └── 用户设置 delete-after
           ├── 到期前 requeue 到较早的领域检查或删除期限
           └── 到期后调用 ResourceClient.delete()
                    └── Baton terminating reconcile ── 物理删除
```

`delete-after` 保存 ISO 绝对时间，而不是只保存一段相对 TTL，避免重启或重复 reconcile 时重新
起算。用户界面可以把“7 天后删除”一次换算成该 annotation；修改或删除 annotation 就能延后或
取消策略。metadata 变化会触发 reconcile；未到期时统一 policy wrapper 保留更早的领域 wakeup，
到期后请求删除；进入 `deletionTimestamp` 后仍委托原 Controller 完成 terminating cleanup。

reqloop 目前仍没有自动设置期限的 Usage、lease、terminal TTL 或 `lastSeenAt` 规则。Source 一次
没有 emit 某个 identity 可能只是分页、窗口、权限或临时失败，因此 omission 不构成删除证据。
终态、离开 workspace 和 Board 不可见也只影响观察与展示，不会隐式设置期限或销毁 Resource。
`delete-after` 是 annotation 而非 label：它需要被 reconcile 读取，但不用于 Resource 集合检索；
可检索的分组字段才应使用受约束的 label。

Workspace 是当前模型中的**逻辑观察根**，不是 Baton 结构 owner。Workspace、Repository、
PullRequest 和 Requirement 目前都未设置 `metadata.owner`，所以删除 Workspace 不会级联删除
其它 reqloop Resource；PullRequest 到 Requirement 的 `ResourceRef` 也是可独立存在的领域关联，
不能改成结构 owner。只有当一个 dependent 脱离 owner 后没有独立存在意义时，才应建立 owner
链并使用 Baton cascade。

因此当前闭环分两层看：

- **Baton 机制闭环**：显式删除请求可以经过 `deletionTimestamp`、terminating reconcile、
  失败重试和最终物理删除；详见
  [Plugin Resource 生命周期](https://github.com/compforge/baton/blob/main/docs/resource-lifecycle.md)。
- **reqloop 用户策略闭环**：用户给出的绝对删除期限可以持久调度并最终请求删除；首版不自动
  推断这个期限，保留 Resource 仍是默认行为，避免把一次观察缺失误判为删除。

### 状态、事件、决定与动作

reqloop 的第一阶段不是追求无人值守，而是先把自动化所需的数据基础建稳：明确有哪些领域概念，
哪些字段表达外部事实或人的决定，世界中的变化如何引起状态转换，以及下一步动作需要什么授权。
只有这些边界稳定后，反复发生的人工流程才能安全地下沉为 reconcile 规则或权限策略。

```text
外部变化 / 人的操作 / Harness 结果
              │
              ▼
 Source emit / Watch 只负责 enqueue
              │
              ▼
 必要时由 Connector 重新读取外部事实
              │
              ▼
 Resource status（事实 + 持久决定）
              │
              ▼
 Reconcile 计算差距并选择动作
```

Source、Watch、cron 和事件不直接表示事实。例如“收到 review webhook”只说明 PR 可能变化；
Controller 仍须读取 Forge，更新 `reviewThreads` 和 `reviewActivityKey`。后者是外部 review
thread/comment 集合的稳定指纹：即使状态一直是 `unresolved`，新评论或解决状态变化仍会产生
新的活动 key，让后续自动化能够区分一次新的外部事件。

人的领域决定也属于可恢复状态，而不是 UI 回调。PR 是否挂到 Requirement 通过 durable
Interaction 询问一次，回答写回 `requirementAssociation`。系统事实和人的决定放在不同字段，
因此 merge conflict、review activity 等外部变化不会覆盖归属选择，也不会让系统重新提问。

动作按副作用与判断来源分层：

| 动作 | 例子 | 默认审批边界 |
|---|---|---|
| Observe | 查询 Forge、需求或部署状态并更新 status | 只读，可自动执行 |
| Recommend | 用户 accept review 后建议 Harness 判断并修复 finding | 生成 proposed-input，由用户确认或编辑 |
| Decide | 选择 PR 归属、确认是否关闭 Requirement | durable Interaction，一次决定持久复用 |
| Mutate | 合并 PR、关闭外部需求、部署到环境 | 需要明确授权；以后只能在限定 Resource、环境、Connector 和有效期的策略内自动化 |

自动化提升的是某一类动作在明确范围内的信任等级，不是绕过状态模型的一键开关。每次执行仍要
保留意图、结果和最新外部观测；副作用不确定时先重新观察，不能盲目重试。

集合发现有两条并行入口：DevloopPullRequestSource 监听本地状态，缩短当前 PR 的发现路径；
ForgePullRequestSource 通过 `ForgeConnector.list()` 周期性读取外部候选，并独立决定哪些
identity 应成为 Resource。Connector 只提供外部查询能力，不能创建或删除 Resource。
PullRequest 创建后由 Baton 自动入队，逐 Resource 的 PullRequestController 再通过
`ForgeConnector.get()` 刷新状态。merged 保留为 Requirement 收尾证据，并在 review 状态为
unknown 或 unresolved 时继续观察；closed 和 review 已收敛的 merged 不再轮询，closed 也不会
被发现。PullRequest 的关联或观察 status 改变后，Requirement 的 Watch 将 create / update /
delete 事件映射到关联 Requirement；Requirement reconcile 再读取最新 PullRequest 集合更新
完成条件；本地派生汇总不依赖 Requirement 平台本次观察成功，外部观察使用独立 freshness
节奏。未来其它发现手段仍应确保同一
Repository 或落成同一种 PullRequest，再复用既有 reconcile 路径。

### RequirementController

`RequirementController` 管理 Requirement Resource。Requirement 自身变化、PullRequest Watch
映射出的 `ReconcileRequest`、Harness 结果、启动恢复、Controller cron Source 和
`requeueAfter` 到期都只负责让某个 Requirement 重新进入 reconcile；Controller 读取
最新 `spec/status` 和必要的外部状态，再决定当前是否需要：

- 更新 `status`，并通过 `present(resource)` 生成 Board presentation；
- 调用 reqloop 自己的 Connector，使外部状态靠近 `spec`；
- 返回一份 `kind: "interaction"` 的 Plugin Output，请用户作出由当前 Resource 消费的决定；
- 返回一份 `kind: "proposed-input"` 的 Plugin Output，建议用户审核后交给 Harness；
- 没有下一步时等待新事实，或用 `requeueAfter` 安排下一次检查。

Requirement 外部观察和 PullRequest 派生投影由同一个 RequirementController 收敛，但不共享可用性：
`lastObservedAt` 控制 Connector freshness，PullRequest Watch 触发的 reconcile 可以直接使用
本地 Resources 更新 `linkedPullRequests` 和 `ReadyToClose`；即使外部观察失败，也先完成本地
投影，再保留失败 condition 并交给 Baton 重试。

当前实现中，Connector 成功或失败分别把 `Observed` 更新为 `True` 或 `False`。
`ReadyToClose` 在没有关联 PR、存在未合并 PR、冲突或未解决 review thread 时为 `False`；
所有关联 PR 已合并但 review thread 状态不可观察时为 `Unknown`；至少一项关联 PR 且全部合并、
review thread 均为 none 或 resolved 时才为 `True`。关闭提醒直接消费这个 condition，不维护
第二套完成判断。

Controller 不把触发原因当成必须执行一次的命令。重复触发、队列合并或进程重启都可以让同一
key 再次 reconcile；只要 `spec` 和外部状态没有变化，它就不应产生新的非幂等动作。Board 是
Requirement 面向人和其他参与者的共享展示与操作面，而不是另一份领域事实源。

### Deployment

Deployment 表示“将某个 Delivery 投放到目标环境的一次尝试”。它独立于具体 pipeline，至少
需要区分目标环境、输入交付物、运行状态、结果和外部引用。

部署成功只是事实，不自动意味着 Requirement 完成；是否继续 review、修复或收尾由
Completion Policy 决定。

### Evaluation

Evaluation 表示对某个 Delivery 或 Deployment 的结构化评估，例如 passed、changes requested、
blocked 或 inconclusive，并携带证据引用。review、e2e、eval 和 perf 可以有不同 payload，
但都能驱动“继续、修复、确认或终止”的决策。

## 3. Connector：reqloop 的内部适配层

Connector 是 reqloop 内部的领域 port，用于隔离外部平台差异。它不是 Baton 概念，也不注册为
Baton host 中的独立组件。

```text
                        reqloop
┌───────────────────────────────────────────────────────┐
│ Requirement / Reducer / Controller / Policy / Commands│
│                    │                                  │
│          internal Connector ports                     │
│       ┌────────────┼─────────────┬─────────────┐       │
│       ▼            ▼             ▼             ▼       │
│ Requirement      Forge       Deployment     Evaluation  │
│ Connector      Connector     Connector       Connector  │
└───────┬────────────┬─────────────┬─────────────┬───────┘
        ▼            ▼             ▼             ▼
   Meego/TB    GitHub/GitLab   BITS/K8s/...   Review/Eval/...
```

首批内部 port 可以按领域拆分：

- **RequirementConnector**：查询、读取、更新和关闭 Requirement，观察需求变化；
- **ForgeConnector**：列出和读取 PR/MR，观察生命周期、review thread 与 merge conflict；
- **DeploymentConnector**：创建部署、读取状态、取消或重试，观察部署结果；
- **EvaluationConnector**：发起或读取 review/eval，观察 evaluation 变化。

Connector 只做三件事：

1. 调用外部平台协议；
2. 将外部 DTO 映射为 reqloop 领域对象；
3. 将平台变化归一成 reqloop 领域事实。

Connector 不负责 Baton session 路由、Board 渲染、Harness 选择、完成条件或跨领域编排。
它也不持有 ResourceClient 或创建 Resource；这些职责分别属于 Baton、Source 和 reqloop
domain。`list()` 的状态、数量等参数只是外部查询能力，具体查询窗口和 Resource 准入由调用它的
Source 决定。

`/requirements` 的搜索词属于一次 Picker 交互，不是 Requirement 状态。Baton 负责输入防抖和
过期响应丢弃，reqloop Command 将最新查询词交给 RequirementConnector，再返回新的 Picker
快照。当前使用有界结果集且不分页；空结果仍返回 Picker，以保留搜索上下文。

Connector port 不依赖具体传输方式。首版 Meego adapter 通过公开发布的 Meegle CLI 调用平台：
它复用 CLI 已有的 OAuth、系统钥匙串、profile 和结构化 JSON 输出，避开 Meego Plugin
OpenAPI 的权限发布与空间安装链路；代价是使用者需要额外安装 CLI 并建立个人登录态。后续若
OpenAPI 接入条件成熟，只替换 Meego adapter，不改变 Requirement 模型、Command 或
Requirement Resource。

实现可以叫 `MeegoRequirementConnector`、`TeambitionRequirementConnector`、
`GitHubForgeConnector`、`GitLabForgeConnector`、`BitsDeploymentConnector`。它们由 reqloop
内部 registry 根据 PluginInstance 配置选择；
Baton 只看到 reqloop PluginInstance，不看到 Connector identity。

Forge 的设计沿用 devloop 已验证的边界：PR/MR 等领域对象保持 provider-neutral，provider 是
repository/Connector 级事实；不同平台 adapter 平级实现同一 port，平台词汇和 DTO 只存在于
adapter。reqloop 复用这套模型原则，但不导入 devloop 的实现或读取其私有状态。首版
`GitHubForgeConnector` 使用 REST 观察生命周期和 merge conflict、使用 GraphQL
`reviewThreads` 观察 review thread；`GitLabForgeConnector` 使用 Merge Request 与
Discussions API，并只把 `resolvable` discussion 当作 review thread。相关 API 不可用时状态
保持 `unknown`，普通 conversation comment 不参与完成条件。

### 配置与多实例

一个 reqloop PluginInstance 可以配置多个具名 Connector，例如多个需求源、dev/test/prod
部署目标和多个 evaluation source。配置 schema 和使用方式由 reqloop 定义；Credential 当前随
具名 Connector 存在本机配置中，后续再迁移到 Baton 的 secret binding。

连接配置使用 Baton 注入的 Plugin data directories，在 `global`、`project`、`session` 三个
scope 中分别读取 `config.json`，并按由宽到窄的顺序递归覆盖；Instance scope 不承载配置。
配置以 source 为 key 同时启用多个 Connector；Meego source 只保存 `projectKey`、可选 CLI
profile 和 category 列表，OAuth token 由 Meegle CLI 管理。`forges` 沿用 devloop 的
host-keyed registry：
map key 同时是 PullRequest `source`，显式 `type` 优先；`github.com` / `github.*` 默认识别为
GitHub，其余默认 GitLab；`api_host` 可将 SSH alias 或 mirror 指向真实 API host。GitHub token
按 `GITHUB_TOKEN`、`GH_TOKEN`、配置 `token` 的顺序读取，GitLab 按 `GITLAB_TOKEN`、配置
`token` 的顺序读取。每个 scope 的目录已经按 `pluginId` 隔离，不与其它 Plugin 混用；
reqloop 的运行时状态仍不能进入配置文件。Requirement 始终是 BatonSession-scoped Resource。

首版 Connector 随 reqloop package 交付，不急于开放第三方 Connector SDK。等出现独立发布、
版本兼容和多团队贡献的真实需求后，再设计 reqloop 自己的扩展机制，避免提前在 Baton 中恢复
第二套 Plugin 系统。

## 4. reqloop 注册到 Baton 的能力

从 Baton 视角，reqloop 只是一个能力较完整的 Plugin：

```text
reqloop
├── slash command    /requirements
├── context provider requirement
└── controller       Requirement
    ├── spec/status schema
    ├── reconcile    按 Requirement key 收敛状态
    └── present      Requirement、进展、证据和待处理事项
```

ContextProvider 注册本地 kind `requirement`，Baton 将 Plugin kind 限定为
`reqloop@requirement`。候选搜索只读取当前 BatonSession 已物化且仍活跃的 Requirement
Resource，不在用户输入 `@` 时调用 RequirementConnector；选中后按 Baton 给出的字符预算，将
需求详情和已知交付状态注入单次 Harness turn。外部平台仍由 Controller 定时刷新，避免交互式
搜索的延迟、失败或凭据状态污染输入体验。

reqloop 的 Connector 是 Controller 的内部依赖，不提升为 Baton 顶层能力。Controller 可以在
manifest 已声明、当前 `spec` 已授权的范围内直接调用 Connector：

```text
Requirement.spec 要求 review
  → RequirementController.reconcile
  → EvaluationConnector.start(stable operation key)
  → patch status.review = running
  → requeueAfter
  → EvaluationConnector.get
  → patch status.review = completed
```

外部操作如果超时，Controller 先按稳定 operation key 重新观察，不能盲目重复创建。只有将来
出现无法自然表达成 `spec`、又需要被独立调用的一次性命令时，才为 Baton 增加 Action。

## 5. 与 devloop 和 Harness 的关系

devloop 下沉为 Harness 内部 Plugin，用 Codex/Claude Code 自己的 skill、hook、command 和
permission 机制规范 agent 的 PR/MR 开发小闭环。它不是 Baton Plugin，reqloop 不直接发现、
配置或调用 devloop。

```text
Baton ──context / user turn──▶ Harness
                                │
                           devloop 约束
                    开发 → lint/test → PR/MR
                                │ DevelopmentOutcome
                                ▼
                     Harness adapter / bridge
                                │ harness.delivery.ready
                                ▼
                              Baton
                                │ persisted event
                                ▼
                      RequirementController
                           ├── patch status
                           └── Connector: 部署/review/收尾
```

reqloop 只消费 Baton 归一后的 `harness.delivery.ready`、`harness.development.blocked` 等事件和
资源引用。这样 Requirement Loop 不依赖某个 Harness Plugin 的私有文件、hook payload 或安装
方式；未来其他 agent-loop 规范工具也可以产生同一 DevelopmentOutcome。

review 完成提醒是首个渐进落地的例外适配：devloop 仍在 Harness 内触发 review，并把终态追加到
各 checkout 自己的 `review-history.jsonl`；reqloop 内部的 Workspace-aware
`DevloopReviewConnector` 遍历当前 Workspace 发现的 checkout，将这些外部 ledger
映射为带完整 `source + repository + number` identity 的 PullRequest review observation，
PullRequestController 通过固定 cron Source 定时重读，并把 review key/status/sha/counts
持久化到同一个 PullRequest Resource；有 findings、文件失败或 review error 时，先返回
`interaction` 让用户选择 accept 或 ignore。决定按 review key 写入 PullRequest status，两种
选择都只提醒一次；accept 返回 `proposed-input`，让当前 Harness 判断并修复真实问题，ignore
不驱动 Harness。
devloop 的 channel/waiter
不再是 Baton 内提醒成立的前提；Connector 只消费 `review sha == 当前 checkout HEAD` 的记录，
且忽略没有开放 PR/MR identity 的本地 review，避免 repo 级 ledger 中其他 worktree 的结果串到
当前会话。Baton core 不解析 `.devloop` 格式。

首期 reqloop 需要用户作出领域决定时返回 `PluginOutput(kind: "interaction")`，Baton 先持久化
回答再重新 reconcile 原 Resource；需要修改代码或诊断失败时返回
`PluginOutput(kind: "proposed-input")`。Baton
将它展示到 InteractionDock；用户采用后进入 composer，可原样提交、编辑后提交，也可直接
丢弃。只有提交后才成为普通 Input，继续走现有 Input → Attempt → Harness 路径。reqloop
不直接调用 Codex/Claude Code，也不持有其原生 session。

长期如果真实工作区证明必须在无人输入时恢复 Harness，再让 Controller 通过 Baton 的受控能力
请求一个或多个 Harness。该能力嵌套在 Resource/Reconcile 契约下，不提前增加一个顶层
Harness Work 类型；Harness 的路由、成本、并发、取消和可靠投递仍归 Baton。

## 6. 用户主流程

1. 用户安装并启用 reqloop，配置需求与部署平台。
2. reqloop 激活时，Repository Sources 从 Workspace 的有界 checkout 中准入或恢复共享的
   Repository；PullRequest Sources 再通过本地 devloop 状态和 Forge 列表准入 PR/MR。
3. 用户通过 `/requirements` 选择需求，或直接粘贴、输入一项需求；reqloop 创建或恢复
   Requirement Resource，将目标和验收条件写入 `spec`，并展示到 Board。
4. RequirementController 返回“根据需求完成开发并提交 PR”的 `proposed-input` Output，Board 展示这段
   文本。用户原样提交或编辑后提交，Baton 组装 context 并交给目标 Harness；这仍是
   user-driven turn。
5. Harness 内部的 devloop 约束 agent 完成开发小闭环；Harness 边界报告 DevelopmentOutcome，
   或 PullRequest Source 通过 devloop 状态 / `ForgeConnector.list()` 观察到符合准入策略的新
   PR/MR，Baton materialize 或唤醒对应 PullRequest Resource。
   若存在活跃 Requirement 且尚未询问归属，reqloop 发起一次 durable Interaction；用户可关联
   一项 Requirement，也可让 PullRequest 独立存在。决定写入
   `PullRequest.status.requirementAssociation`，不根据匹配猜测自动关联，也不重复询问。
6. PullRequestController 观察 review thread、merge conflict 与 open / merged / closed；
   当前由 devloop 触发的 review 完成后，`DevloopReviewConnector + cron Source` 也可观察其终态；
   后续由 reqloop 自己发起的远端 review 仍可由 EvaluationConnector 配合 `requeueAfter` 查询。
   PullRequest 的 create / update / delete 同时由 Requirement Watch 映射到关联 Requirement，
   update 在改挂时会同时 reconcile 旧、新两侧。
7. review 要求修改时，Controller 让用户 accept 或 ignore；两种选择都写入 PullRequest status
   且只提醒一次。accept 返回包含 review 意见的修复 `proposed-input`，用户审核后再次驱动 Harness。
8. 首期 Completion Policy 在至少存在一个关联 PR、所有关联 PR 已 merged 且 review thread
   状态均为 none 或 resolved 时，吐出一次去重 toast，提醒用户前往需求平台关闭 Requirement。外部关闭由
   Connector 重新观察成功后，不再向 Board 展示该 Requirement；当前阶段不执行外部写操作。

Harness turn 停止、Board 更新或 Context 可用都不自动代表下一步已完成。reqloop 总是重新读取
最新 Resource 和外部状态，再决定更新 status、调用 Connector、建议 Harness 输入或等待。

## 7. Board、权限与渐进式自动化

对 reqloop 而言，Board 是与 Baton、其他 Plugin 和多个 Harness 共享的协作状态，而不只是一个
面向用户的进度面板：

> 类比刑侦团队的案件板：每个 Requirement 是一张案件卡；孤立 PR 也有自己的卡片，关联 PR
> 则作为 Requirement 的线索和进展，避免同一工作重复占据顶层位置。reqloop、Harness 和用户
> 都能从同一块板上形成
> 当前认知，但各领域事实仍由自己的 Resource 或外部系统负责。

- 用户通过 BoardView 观察 Requirement Loop 的目标、进度、结果、blocker 和待处理请求；
- ContextComposer 从 Requirement 与 Board snapshot 选择和当前 Harness、session、turn 有关的信息；
- reqloop 从 Requirement 生成 Deployment、Evaluation 等结构化摘要，也可以读取同
  scope 的 Baton 和 Harness observation，决定下一步如何收敛；
- Baton 并行驱动多个 Harness 时，各 Harness 的进度、交付物和交接状态经 Baton 展示到 Board，
  再按目标 Harness 编译成 context，实现受控的状态共享。

“可行动事项”和“状态事实”只是 UI 可使用的默认 facet，不是封闭数据类型或固定页面布局。
reqloop 读取带 revision 的结构化 BoardSnapshot，不解析面向人的渲染文本。

reqloop 只能更新自己的 Resource status；Board presentation 只能从 Resource 派生，不能覆盖
Baton 或 Harness 的事实；它通过 resourceRef、领域 ID 和 provenance 关联不同事实持有方的信息。并行 observation 由
Controller 汇入新的 Resource revision，各 Plugin 和 ContextComposer 总是基于明确版本读取。

Board 也不是 reqloop 唯一的信息通道。领域事件仍走 Baton Event Ledger，Connector 原始状态
仍保留在外部系统或 reqloop 私有缓存，大体积证据通过 Resource reference 按需读取；只对一次
Harness turn 有效或不适合共享的信息可以在 context 交付时单独补充。

reqloop manifest 声明 Connector 可能访问和修改的外部资源范围，使用户在启用 Plugin 时预先
知道它可能做什么。`spec` 表达已经认可的 desired state；部署生产或关闭需求等敏感变化应在
对应 spec 更新落盘前经过 Baton Permission Gate。Controller 只能收敛已授权的 spec，不能在
运行时自行扩大 operation 或 scope。Plugin 升级新增权限或扩大 scope 时必须重新授权。

自动化按信任渐进：

```text
Observe    Controller 只更新 Resource / Board，由人判断和执行
Recommend  Controller 给出 proposed-input Output
Confirm    Controller 用持久 interaction 取得 Resource 决议
Approve    人审核、编辑后提交为普通 Input
Automate   已授权 spec 下的 Connector 操作自动收敛
Autonomous 真实工作区证明需要无人续跑后，再开放受控 Harness 调用
```

理想状态可以是用户什么都不做，但它是长期信任积累的结果，不是首次启用 reqloop 的默认模式。

## 8. 状态与恢复

Requirement 是 reqloop 持久化的 Resource，不以 Board 文本作为真相源。`spec` 保存用户
认可的 Contract，`status` 保存 Controller 对 Baton、Harness 和外部系统事实的当前观测；私有
Connector cursor 和缓存只用于加速读取，不成为第二真相源。

```text
Input / Harness Event / external observation / cron or timer due
                         │
                         ▼
                    Requirement
                         │
                         ▼
             RequirementController
                  ├── patch status
                  ├── Board presentation / Resource Context source
                  ├── PluginOutput(interaction / proposed-input)
                  └── requeueAfter（仅动态复查）
```

BoardView 和 ContextBundle 按不同预算与受众从 Requirement 和相关事实中派生。Resource 创建、
spec 更新、Harness 结果、cron Source 和 `requeueAfter` 到期都会 enqueue 同一 key；Baton 合并重复触发，并
保证同一个 Requirement 不并发 reconcile。

RequirementController 可以调用自己拥有的 Connector，但外部写入使用稳定 operation key；调用超时
或进程崩溃后先查询实际状态，再决定是否继续。`nextReconcileAt` 随 Resource 持久化，Baton
重启后恢复到期检查。Board 仍是跨参与者共享的协调读模型，不取代 Requirement 或外部系统的事实
来源。

## 9. 关键不变量

1. Requirement、PullRequest、Deployment 和 Evaluation 只属于 reqloop，不进入 Baton core。
2. Connector 只属于 reqloop 内部，不成为 Baton Plugin API 或宿主身份。
3. Controller 可以调用 reqloop Connector，但只能收敛已授权 spec，并对不确定外部写入先观察
   后重试。
4. reqloop 只通过 Baton 的 Input、Event 和 Resource reference 与 Harness 协作；对 devloop
   review ledger 的兼容只存在于 reqloop 内部 Connector，不进入 Baton core，也不允许
   Controller 调用 devloop 的 Harness 私有能力。
5. Controller 用 `interaction` 取得由原 Resource 消费的持久决定，用 `proposed-input` 建议
   Harness 输入；只有用户提交 proposed input 后才形成普通 Input。
6. 未来即使开放主动 Harness 调用，reqloop 也不直接持有 Harness 进程、SDK 句柄或原生 session。
7. Requirement 是 session 级持久 Resource；Connector cursor 和私有 snapshot 只进入
   host-owned reqloop data 目录，Board 与二者都不是独立真相源。
8. reqloop 通过独立 Marketplace Package 交付、可禁用、可升级；Baton core 在没有 reqloop 时
   仍完整工作。
9. Plugin 声明能力不等于获得权限；敏感 desired state 在写入 spec 前完成授权。
10. reqloop 只能修改自己的 Resource status；Board presentation 展示活跃 Requirement 与孤立
    的活跃 PullRequest；关联不改变 PullRequest 的独立身份，只改变 Board 的主展示对象。其他
    事实持有方的产出只能作为 observation 读取。
11. 全量周期唤醒可以使用 Controller cron Source；单个长期 Resource 的下一次检查使用
    `requeueAfter`，调度由 Baton 持久化，不进入 Resource metadata。
12. Resource、Input、Harness 结果、cron 和 timer 只触发重新检查；Controller 不把触发当成必须逐条
    执行的命令。
13. Repository 按 `source + repository` 统一拥有集合发现生命周期，并可被多个 Requirement
    共享；PR/MR 作为 PullRequest Resource 独立观察。归属决定只写入 PullRequest status，最多指向一份
    Requirement。Requirement 不在 spec/status 双写实际 PR/MR 列表。
14. Event、webhook、cron 和 timer 只表示“事实可能变化”；状态转换必须以重新观察后的 Resource
    status 为依据。人的 durable decision 与外部 observation 分字段持久化。
15. 外部集合只能由 Source 准入；Connector 只提供外部能力，Controller 只收敛已经存在的
    Resource。Source omission、terminal status 与 Board 隐藏都不是删除证据。

## 10. 待继续讨论

1. 除“不存在活跃 PR/MR”外，Completion Policy 还需要哪些默认条件，才能区分初始无 PR 与
   开发完成后无 PR？
2. Connector 配置如何表达多个部署环境、租户和 credential binding？
3. 哪些真实场景不能由 Resource 变化、Controller cron Source 或 `requeueAfter` 覆盖，足以引入 EventSource？
4. Requirement Resource 的 spec/status schema 如何版本化和迁移？
5. DevelopmentOutcome 应包含哪些最小字段，才能让不同 Harness Plugin 统一产生
   `harness.delivery.ready` 和阻塞事件？
6. 哪些 Connector 应随首版 reqloop 交付，第三方 Connector SDK 的触发条件是什么？
7. Connector permission scope 如何表达 project、BatonSession、环境和资源范围，Plugin 升级时哪些变化
   必须重新授权？
8. Repository、PullRequest 和 Requirement 未来应由哪些持久证据自动设置 `delete-after`：
   Usage / lease、terminal TTL，还是它们的组合？一次 Source omission 不得作为依据。
