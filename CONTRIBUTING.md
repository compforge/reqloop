# Contributing

## 目录约定

每个 Plugin 收束在 `plugins/` 域下：

```text
plugins/<plugin-name>/
├── .baton-plugin/
│   └── plugin.json
├── src/
│   ├── domain/       # 领域对象、Policy 与 Controller
│   ├── connectors/   # 可选：外部系统协议与 DTO 映射
│   └── index.ts      # PluginPackage 导出入口
├── tests/
├── AGENTS.md          # 可选：复杂 Plugin 的稳定边界与设计索引
├── docs/              # 可选：由 AGENTS.md 引用的设计细节
├── package.json
├── tsconfig.json
└── README.md
```

目录按真实职责渐进创建，不要求空目录占位。一个 Plugin 内文件变多时，优先按领域 owner 收束，
不要横向铺开 `handlers/`、`services/`、`utils/` 等语义模糊目录。只有跨多个模块才能拼出的
稳定设计进入 AGENTS/docs；当前字段、阈值和单文件行为仍以代码为事实来源。

## 新增 Plugin

1. 新建 `plugins/<plugin-name>/`，实现 Baton 公共 Plugin API 暴露的 `PluginPackage`。
2. 添加 `.baton-plugin/plugin.json`，声明稳定 `pluginId`、版本、入口和权限。
3. 在 `.baton-plugin/marketplace.json` 的 `plugins` 数组注册该目录。
4. 在根 `README.md` 和 `README.zh-CN.md` 的 Plugin 列表增加入口。
5. 为激活、关闭、重启恢复和每种 Command / Controller 添加契约测试。

## 边界

- 只允许以 `import type` 从 `@compforge/baton-plugin` 导入 Baton 公共 Plugin 类型；禁止依赖
  Baton 仓库相对路径、宿主包、运行期 value 或内部模块。
- Command 和 Controller 共用 Package、Instance 与 Binding 生命周期，不各自建设平行扩展体系。
- Plugin 会在独立 Runner 进程执行；`activate`、Command、Context、Source、Watch、
  `reconcile`、`present` 和 ResourceClient 调用保持 async，跨边界只返回可结构化传输的数据。
- 产品代码不得使用同步子进程。Git/CLI 调用使用异步 API，并显式配置 timeout、取消和输出上限。
- Resource 的 `spec` 保存用户认可的期望，`status` 保存可重新观测的事实；Connector 缓存不能
  成为第二真相源。
- Controller 的外部写入必须使用稳定 operation key；超时后先观察实际状态，不能盲目重放。
- Marketplace manifest 是可审阅的静态声明，不能写入函数、凭据或 PluginInstance 配置。

## 本地开发

发布新版本时统一使用根目录 target，避免遗漏 Plugin manifest、执行声明或说明文档：

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
