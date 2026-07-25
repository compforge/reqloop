# Contributing

## 目录约定

每个 Plugin 收束在 `plugins/` 域下：

```text
plugins/<plugin-name>/
├── .baton-plugin/
│   └── plugin.json
├── src/
│   ├── domain/       # 领域对象、Policy 与 Reconciler
│   ├── connectors/   # 可选：外部系统协议与 DTO 映射
│   └── index.ts      # PluginPackage 导出入口
├── tests/
├── package.json
├── tsconfig.json
└── README.md
```

目录按真实职责渐进创建，不要求空目录占位。一个 Plugin 内文件变多时，优先按领域 owner 收束，
不要横向铺开 `handlers/`、`services/`、`utils/` 等语义模糊目录。

## 新增 Plugin

1. 新建 `plugins/<plugin-name>/`，实现 Baton 公共 Plugin API 暴露的 `PluginPackage`。
2. 添加 `.baton-plugin/plugin.json`，声明稳定 `pluginId`、版本、入口、Contribution 和权限。
3. 在 `.baton-plugin/marketplace.json` 的 `plugins` 数组注册该目录。
4. 在根 `README.md` 和 `README.zh-CN.md` 的 Plugin 列表增加入口。
5. 为激活、关闭、重启恢复和每种 Contribution 添加契约测试。

## 边界

- 只允许从 Baton 发布的公共 Plugin API 导入契约；禁止依赖 Baton 仓库相对路径或内部模块。
- Command 和 Resource 是 `PluginContribution` 的变体，不各自建设 Package、Instance 或
  Binding 生命周期。
- Resource 的 `spec` 保存用户认可的期望，`status` 保存可重新观测的事实；Connector 缓存不能
  成为第二真相源。
- Reconciler 的外部写入必须使用稳定 operation key；超时后先观察实际状态，不能盲目重放。
- Marketplace manifest 是可审阅的静态声明，不能写入函数、凭据或 PluginInstance 配置。

## 本地开发

发布新版本时统一使用根目录 target，避免遗漏 Plugin manifest、运行时声明或说明文档：

```bash
make bump-version PLUGIN=hello-counter VERSION=0.0.3
```

该命令会同步版本并运行对应 Plugin 的测试。

Baton 的 link、manifest 校验和 Plugin 测试命令尚在实现中。最终约定会收敛为：

```text
baton plugins link <marketplace-or-plugin-path>
baton plugins list
```

`link` 只用于开发，直接引用可变工作区；普通安装必须复制或获取不可变的 Package 版本。两者
使用同一份 manifest 和 PluginPackage 入口，避免形成“开发能跑、安装不能跑”的第二套协议。
