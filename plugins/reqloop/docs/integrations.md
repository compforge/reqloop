# ReqLoop 集成边界

## Connector

Connector 是 ReqLoop 内部的领域 port，不是 Baton 顶层概念：

```text
Command / Source / Controller
             │
             ▼
  provider-neutral Connector port
       ├── RequirementConnector ── Meegle CLI
       ├── ForgeConnector ──────── GitHub / GitLab API
       └── PullRequestReviewConnector ── devloop review ledger
```

Connector 负责调用外部协议、校验响应并映射为 ReqLoop 领域对象。它不持有
`ResourceClient`，不决定哪些外部对象进入系统，也不负责 Board、Harness 路由、完成条件或
跨领域编排。

### Requirement 平台

`RequirementConnector` 当前只有有界列表和单项读取能力。`/requirements` 把搜索词交给所有
具名 Connector，用户选中后再读取详情并物化 Requirement。首个 adapter 通过公开 Meegle CLI
复用其登录态和结构化输出；更换传输方式不应改变 Requirement identity、Command 或 Resource。

### Forge

`ForgeConnector` 提供 PullRequest 列表和单项读取。GitHub/GitLab adapter 平级实现同一
provider-neutral port；平台 DTO 和词汇不穿透到 Resource。review thread 不可用时使用 unknown，
不能把普通 conversation comment 推断为可解决的 review thread。

HTTP adapter 显式处理超时、响应大小、非法 JSON 和 rate limit。限流优先服从服务端 retry
窗口并在 Connector 内暂停后续请求；权限不足可以按契约降级为 unknown，但不能吞掉限流或
传输失败。

## devloop 产出

devloop 负责 Harness 内的开发小闭环；ReqLoop 不导入其实现，也不调用其 skill、hook 或
Harness 私有能力。二者通过本地持久产出形成 producer/consumer 边界：

| 适配器 | 消费的事实 | 用途 |
|---|---|---|
| `DevloopPullRequestSource` | 当前 PR 状态与 review observation | 快速准入 PullRequest |
| `DevloopToolActivityPolicy` | 原始 tool-call 时间线 | ReqLoop 自己解释读写活动，控制 Forge 发现与观察频率 |
| `DevloopReviewConnector` | append-only review history | 映射为与当前 checkout HEAD、branch 和 PR identity 对齐的 review observation |

这些适配器的命名明确表达 devloop 数据来源。格式解析和兼容性只存在于 ReqLoop 内部；
Baton core 不识别 `.devloop` 文件。未知工具和命令信封保持 neutral，ReqLoop 不根据模糊名称
猜测写入意图。

## 配置

ReqLoop 从 Baton 注入的 global、project、session Plugin data 目录依次读取 `config.json`，
按由宽到窄递归覆盖。Instance data 不承载配置，Resource status 也不写回配置文件。

配置以 source 为 key 支持多个 Requirement 与 Forge Connector。凭据和 provider-specific
字段属于 Connector；确切 schema、环境变量优先级和 Meegle CLI 初始化步骤见
[Plugin README](../README.md)，代码事实源分别是 `config.ts`、Requirement adapter 和 Forge
config adapter。

Connector cursor 或缓存只能用于加速外部读取，不能成为另一份领域真相。当前实现没有持久化
Connector cursor。

## Baton 与 Harness

ReqLoop 当前向 Baton 注册：

- `/requirements` Command；
- `requirement` ContextProvider；
- Workspace、Repository、PullRequest、Requirement 四个 Controller 及其 Source/Watch；
- Requirement 与孤立 PullRequest 的 Board presentation。

ContextProvider 只搜索当前 BatonSession 已物化且仍活跃的 Requirement，不在用户输入 `@`
时访问外部平台；选中后按 Baton 给出的字符预算向一次 Harness turn 注入内容。

需要人的领域判断时，PullRequestController 返回 `interaction`；用户确认处理 merge conflict
或 review 时返回对应的 `proposed-input`。Baton 持久化决定并负责 composer、Input、Attempt
与 Harness 路由。ReqLoop 不持有 Harness 进程、SDK 句柄或原生 session，也不会在无人输入时
启动 Harness。

RequirementController 当前只观察、汇总，并在 ReadyToClose 后让用户确认是否结束本地跟踪；
确认结果以 `ClosureRequested` Condition 持久化并发送 toast。外部 Requirement 写入、
PR 合并、部署和主动 Harness 调用都不在现有 Connector 接口或 manifest 权限内。

## 权限与失败

当前外部能力为只读观察；Plugin manifest 应只声明实际需要的范围。未来若增加外部写操作，
必须先把 desired state 和授权 scope 持久化，再由 Controller 使用稳定 operation key 收敛；
超时或进程崩溃后先查询实际状态，不能盲目重放。

Source、Watch、cron 和文件变化只说明“事实可能变化”。状态转换必须基于重新读取的 Resource
或 Connector observation；人的 durable decision 与外部 observation 分字段保存。
