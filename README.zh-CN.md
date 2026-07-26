[English](./README.md)

# reqloop

reqloop 是面向 Requirement Loop 的官方 [Baton](https://github.com/qiankunli/baton)
Marketplace。它是一个多 Plugin 仓库：`plugins/` 下每个 Plugin 目录都是可独立版本化的
Baton PluginPackage，仓库根只负责 Marketplace 发现和公共开发约定。

## 架构概览

Baton Plugin 负责协调长期领域 Loop，但不直接调用 Harness。它通过 Baton 的常规输入、上下文、
权限和路由路径提出建议或提交范围明确的工作；Harness 作为智能执行能力提供方，devloop 等
Harness Plugin 则约束 Harness 内部的开发小闭环。

![Baton、Plugin 与 Harness](./docs/baton-plugin-harness.svg)

ReqLoop 将需求、代码、review、CI 和部署系统接入同一条 Loop，把外部状态和用户的持久决定
整理为 Resource，并从观察、建议和人工确认逐步走向范围明确的自动化。

![ReqLoop 工作框图](./docs/reqloop-workflow.svg)

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
Hello Counter 和 Turn Coach 验证 Resource/Reconcile、Baton-owned Resource watch 和持久
Proposal；ReqLoop 是首个 Requirement Loop Package，提供 `/requirements` 并观察外部
devloop review 状态。

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
docs/reqloop.md                 Requirement Loop 领域模型与 Connector 设计
docs/baton-plugin-harness.*     Baton Plugin 与 Harness 关系图
docs/reqloop-workflow.*         ReqLoop 工作框图（SVG 与 PNG）
CONTRIBUTING.md                 新 Plugin 接入规则
AGENTS.md                       架构与维护约束
```

领域模型与 Connector 留在拥有它们的 Plugin 内。Baton core 只提供通用的 Package、Instance、
Binding、Resource/Controller 和 Proposal 契约。

## Plugins

- [Hello](./plugins/hello/README.md) — 用于验证 Marketplace 发现、安装和加载的最小 `0.0.1`
  Package。
- [Hello Counter](./plugins/hello-counter/README.md) — 演示可写 Resource 与
  `baton.turn` Controller 的组合。
- [Turn Coach](./plugins/turn-coach/README.md) — 验证 Baton-owned Resource replay、持久状态和
  proposed input 的端到端 canary。
- [ReqLoop](./plugins/reqloop/README.md) — 需求级闭环协调；`0.1.8` 物化 Requirement
  Resource、观察 Forge review 活动，并只询问一次 PullRequest 是否关联 Requirement。

领域模型、Connector 边界与 Harness 协作方式见
[Requirement Loop 设计](./docs/reqloop.md)。

新增 Plugin 前请阅读 [CONTRIBUTING.md](./CONTRIBUTING.md)。
