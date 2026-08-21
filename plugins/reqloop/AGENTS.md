# compforge/reqloop

## 项目定位与边界

`compforge/reqloop` 是 reqloop Marketplace 中负责 Requirement Loop 的 Baton Plugin。它在
Baton core 之外拥有 Requirement、Workspace、Repository、PullRequest、CodeReview，以及
Component、Environment、Service 领域模型，
通过 Baton 的 Resource、Controller、Source、Watch、Board、Mention、Context 和 Plugin verb 契约运行。

当前阶段以观察、关联、提醒和建议为主：可以读取需求平台、Forge、devloop 与 Kubernetes 事实，
但不直接修改外部 Requirement、不合并 PR/MR、不发布或修改环境，也不主动驱动 Harness。长期方向
与当前实现严格分开，见 `docs/roadmap.md`。

## 代表性用户故事

下面描述用户期望完成的一条典型工作链路；不是所有工作都必须始于需求平台，也不表示每一步
都已由当前版本自动完成。

1. 用户可以选择一项已有需求开始工作，需求会出现在工作看板上；没有外部需求的临时工作也
   可以直接开始。
2. 用户提交开发任务，开发助手完成编码、检查和测试，并提交 PR/MR。
3. 系统发现新 PR/MR 后，将它关联到对应需求。能够可靠判断时自动关联；无法判断时，再请用户
   选择已有需求、引入新的需求，或保持独立。
4. 代码评审完成后，系统提醒用户查看结果，并询问是否交给开发助手处理。
5. 用户确认后，开发助手判断评审意见是否成立，修复真实问题、说明误报，并完成相关验证。
6. 当评审意见已处理、PR/MR 已合并等完成条件满足时，系统询问用户是否可以关闭需求。
7. 用户确认并完成需求关闭后，该需求不再出现在工作看板上。

## 代码地图与核心模块

```text
plugins/reqloop/
├── src/
│   ├── index.ts                  # PluginPackage 装配与唯一注册入口
│   ├── config.ts                 # global/project/session 配置覆盖
│   ├── retention.ts              # 用户显式删除期限 policy
│   ├── deployments/              # 全局 Component/Environment/Service 与 Kubernetes 感知
│   ├── workspaces/               # Project 观察根与 checkout 发现
│   ├── repositories/             # 仓库观察范围与 PR 集合汇总
│   ├── pull-requests/            # PR/MR 准入、Forge/devloop 观察与用户决定
│   ├── code-reviews/             # AI code-review 运行、结果、决定与短期生命周期
│   └── requirements/             # 需求选择、外部观察、Mention Context 与完成条件
├── tests/                        # Resource、Controller、Source、Connector 契约测试
├── docs/                         # 当前设计细节与长期方向
├── RELEASE.md                    # 当前版本与发布记录
└── README.md                     # 安装、配置与用户使用方式
```

各领域目录内，`protocol.ts` 定义领域模型和 Connector port；Requirement/Forge 保持
provider-neutral，Deployment 用判别类型显式表达基础设施 target。`resource.ts` 负责稳定
Resource 身份与状态写入，`controller.ts` 负责 reconcile 和 Board projection；
外部协议适配放在 `connectors/`，集合准入放在 `sources/`。

## 关键约定

1. **Resource 身份与事实 owner 唯一**：Component、Environment、Service 位于用户全局 `v1`；
   其余领域 Resource 写入稳定的 `v1/project/<project-id>` namespace，Workspace 是 Project
   逻辑观察根；同一目录的多个 Session 共享一组 Resource。PluginPackage 本身不声明 namespace。
   Repository 按
   `source + repository` 共享，PullRequest 按 `source + repository + number` 独立存在，
   Requirement 按 `source + category + id` 唯一；CodeReview 按目标 PR 与一次已发布的 review
   run 唯一。PR 与 Requirement 的归属只写
   `PullRequest.status.requirementAssociation`，一份 PR 最多关联一份 Requirement；
   Requirement 只保存派生汇总，不反向双写关联列表。
2. **Source 准入，Controller 收敛**：只有 Command 或 Source 可以让外部对象成为 Resource；
   Watch、cron 和文件变化只负责 enqueue。Controller 每次读取最新 Resource 和必要的外部事实，
   不用 `Connector.list()` 扩张集合；Connector 不持有 `ResourceClient`，也不拥有 loop。
3. **事实、人的决定和展示分层**：外部观测写 status，用户决定通过 durable Interaction
   持久化后再写领域状态；Board 与 Context 都从 Resource 派生，不成为第二事实源。
   devloop review history 只提供低延迟变化信号；已发布 AI review 的 finding 与 label
   仍通过现有 `ForgeConnector.comments()` 读取，不另设 review connector。Baton core
   不解析这些格式，reqloop 也不调用 devloop 的 Harness 私有能力。
4. **保留优先于猜测删除**：Source omission、离开 Workspace、进入 terminal 或从 Board
   隐藏都不是删除证据。默认保留 Resource；只有用户显式设置删除期限后，才通过 Baton 的
   terminating 生命周期删除。短期 AI CodeReview 是明确的例外：ignore 或完成 finding
   label 后隐藏，到领域 TTL 后删除。Workspace 是逻辑观察根，不是其它 Resource 的结构
   owner。
5. **外部协议与访问细节隔离**：Requirement/Forge 对象保持 provider-neutral；部署模型显式
   区分 Kubernetes 等基础设施类型，但凭据和协议 DTO 仍属于具名 Connector。Project loop 配置
   可按 global/project/session 覆盖，全局部署目录只读 global config；Instance data 不承载配置。
   外部调用失败、限流或重启后重新观察并幂等收敛，不能把缓存、事件或触发原因当作事实。
   修改本 Plugin 的代码时，同一变更必须通过 `make bump-version`
   （`PLUGIN=reqloop VERSION=<next>`）同步 Package、manifest、package.json 与发布记录；
   纯文档改动不单独 bump。
6. **Environment 拥有部署基础设施**：Kubernetes 是 Environment 的显式 target 类型，但不是
   Environment 的定义；Service 引用 target 并声明具体 K8s 对象映射。Connector 只保存
   kubeconfig/context 等访问细节并进行只读观察，详见 `docs/deployment.md`。

## References

- `README.md` — 安装、配置和当前用户能力
- `RELEASE.md` — 当前版本与发布记录
- `docs/domain-model.md` — 八种 Resource 的身份、owner 与 Board 语义
- `docs/deployment.md` — Component、Environment、Service 与 Kubernetes 感知
- `docs/reconcile.md` — Command/Source/Watch/Controller 流程、保留与恢复
- `docs/integrations.md` — Requirement/Forge/devloop/Harness 集成边界
- `docs/roadmap.md` — 尚未实现的长期闭环与引入新概念的条件
- Baton Plugin 契约：
  `https://github.com/compforge/baton/blob/main/docs/plugin.md`
- Baton Resource 生命周期：
  `https://github.com/compforge/baton/blob/main/docs/resource-lifecycle.md`
