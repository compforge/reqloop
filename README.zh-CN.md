[English](./README.md)

# reqloop

reqloop 是面向 Requirement Loop 的官方 [Baton](https://github.com/qiankunli/baton)
Marketplace。它是一个多 Plugin 仓库：`plugins/` 下每个 Plugin 目录都是可独立版本化的
Baton PluginPackage，仓库根只负责 Marketplace 发现和公共贡献约定。

目标开发使用流程是：

```text
开发 Plugin
  → 构建并校验 manifest
  → 将 Marketplace 或 Plugin link 到 Baton
  → 在 /plugins 中为当前 BatonSession 创建并启用 PluginInstance
  → 激活 PluginBinding
  → 使用 Command 与 Resource/Reconcile 工作流
  → Baton 重启后恢复同一条 loop
```

## 当前状态

本仓库随 Baton 的外部 Plugin runtime 一起演进。Hello 验证最小 Package 生命周期，
Hello Counter 和 Turn Coach 验证 Resource/Reconcile、Builtin Resource watch 和持久
Proposal；ReqLoop 是首个 Requirement Loop Package，用于观察外部 devloop review 状态。

## 在 Baton 中安装和使用

将本 Git 仓库注册为 Marketplace，并安装所需 Package：

```bash
baton plugins marketplace add https://github.com/qiankunli/reqloop.git
baton plugins install qiankunli/turn-coach --marketplace reqloop
baton plugins install qiankunli/reqloop --marketplace reqloop
baton plugins list
```

本地开发时，将 Git URL 换成本地 checkout 路径：

```bash
baton plugins marketplace add /path/to/reqloop
```

安装 Package 后，启动 `baton`，输入 `/plugins`，进入 **Installed**，选择对应 Package，再执行
**Enable in this session**。Turn Coach 会复盘已完成的 turn 并建议下一步；ReqLoop 会观察当前
Session 仓库中的 devloop review 终态，在 comments 需要检查时提供一条驱动当前 Harness 的建议输入。

## 仓库结构

```text
.baton-plugin/marketplace.json  Marketplace 索引
plugins/<plugin-name>/          一份独立版本的 Baton Plugin
CONTRIBUTING.md                 新 Plugin 接入规则
AGENTS.md                       架构与维护约束
```

领域模型与 Connector 留在拥有它们的 Plugin 内。Baton core 只提供通用的 Package、Instance、
Binding、Contribution、Resource/Reconcile 和 Proposal 契约。

## Plugins

- [Hello](./plugins/hello/README.md) — 用于验证 Marketplace 发现、安装和加载的最小 `0.0.1`
  Package。
- [Hello Counter](./plugins/hello-counter/README.md) — 演示可写 PluginResource 与
  `baton.turn` watch 的组合。
- [Turn Coach](./plugins/turn-coach/README.md) — 验证 Builtin Resource replay、持久状态和
  proposed input 的端到端 canary。
- [ReqLoop](./plugins/reqloop/README.md) — 需求级闭环协调；`0.1.0` 首先支持 devloop review
  完成提醒。

新增 Plugin 前请阅读 [CONTRIBUTING.md](./CONTRIBUTING.md)。
