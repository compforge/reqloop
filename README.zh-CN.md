[English](./README.md)

# reqloop

reqloop 是面向 Requirement Loop 的官方 Baton Marketplace。它是一个多 Plugin 仓库：每个根级
Plugin 目录都是可独立版本化的 Baton PluginPackage，仓库根只负责 Marketplace 发现和公共贡献
约定。

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

本仓库正与 Baton 的外部 Plugin 和 Marketplace 支持一起初始化。目前还没有从该 Marketplace
发布 Plugin。第一条实现会先打通完整的本地开发链路，再增加远程安装和 Marketplace 更新。

## 仓库结构

```text
.baton-plugin/marketplace.json  Marketplace 索引
<plugin-name>/                  一份独立版本的 Baton Plugin
CONTRIBUTING.md                 新 Plugin 接入规则
AGENTS.md                       架构与维护约束
```

领域模型与 Connector 留在拥有它们的 Plugin 内。Baton core 只提供通用的 Package、Instance、
Binding、Contribution、Resource/Reconcile 和 Proposal 契约。

## Plugins

目前尚未发布 Plugin。

新增第一份 Plugin 前请阅读 [CONTRIBUTING.md](./CONTRIBUTING.md)。

