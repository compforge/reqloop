# reqloop

## 项目定位与边界

reqloop 是 Baton 的 Requirement Loop Plugin Marketplace，不是单 Plugin 仓库。仓库根只负责
Marketplace 索引、跨 Plugin 约定和开发工具；`plugins/` 下每个子目录是一份可独立安装、
版本化和启用的 Baton Plugin。

reqloop 中的 Plugin 可以分别处理需求、交付、部署、评测或其他长期闭环，但 Requirement、
Deployment、Evaluation 等领域类型仍归拥有它们的 Plugin，不进入 Baton core。Plugin 只依赖
Baton 发布的公共 Plugin API，不能相对路径导入 Baton 源码或持有其内部 Store、Controller、
Harness 进程或 SDK 句柄。

## 代码地图与核心模块

```text
reqloop/
├── .baton-plugin/
│   └── marketplace.json   # Baton Marketplace 索引
├── plugins/               # Plugin 域：一份子目录对应一个独立 PluginPackage
│   └── <plugin-name>/
│       ├── .baton-plugin/
│       │   └── plugin.json
│       ├── AGENTS.md             # 可选：该 Plugin 的稳定设计边界与 References
│       ├── docs/                 # 可选：该 Plugin 的设计细节
│       ├── src/
│       │   └── index.ts          # PluginPackage 导出与装配入口
│       ├── tests/
│       ├── package.json
│       └── README.md
├── docs/                  # Marketplace 级说明图
├── CONTRIBUTING.md        # 新 Plugin 接入与索引规则
└── README.md              # Marketplace 用户入口
```

不要为尚未出现的能力预建 `common/`、`utils/` 或共享 SDK。真实的跨 Plugin 稳定代码出现后，再
提升到根级 `packages/`，并保持领域对象仍由各 Plugin 自己拥有。

## 关键约定

1. Marketplace 只负责发现和交付不可变的 PluginPackage；PluginInstance、Resource、
   Human Inbox 和调度状态归 Baton Daemon。Package 只组织 Resource、Controller 与 Connector，
   每个 Resource 自己携带 namespace；三方 Package 按启用的 PluginInstance 进入 Plugin Worker
   进程。`@compforge/baton-plugin` 只用 `import type`，所有公开回调保持 async；
   Plugin 自建的 Git/CLI 子进程也必须使用异步 API，并显式设置 timeout、取消和输出上限。
2. 每个 Plugin 的 manifest 声明稳定身份和可审阅权限；运行期能力通过 Command 与 Controller
   注册，Resource kind 在 Marketplace 内保持唯一。
3. Plugin 的领域逻辑与外部 Connector 分离：Source 发现外部对象并贡献其 Controller 拥有的
   Resource，Watch 将 Resource 变化路由给依赖方；Controller 根据最新 `spec/status` 收敛状态，
   Connector 只负责协议调用和 DTO 映射，不能反向拥有 loop。
   Requirement/Forge 等对象保持 provider-neutral，provider 属于 Connector 或其绑定的
   repository，不摊进每个领域对象。连接参数归 Plugin 配置，cursor/cache 归 Baton 注入的
   host-owned data 目录，领域 loop 状态归各自 namespace 下的 Resource。
4. 本地开发可以使用 link 来源，但发布版本必须不可变；来源 provenance 不进入 `pluginId` 或
   PluginInstance 身份。
5. 新 Plugin 必须放进 `plugins/`，同时更新 Marketplace 索引和根 README；具体配置、限制和
   使用方式留在该 Plugin 自己的 README。

## References

- `README.md` — Marketplace 定位、目标使用流程和 Plugin 列表
- `CONTRIBUTING.md` — 新增 Plugin 的目录、manifest 与验证要求
- Baton Plugin 设计：
  `https://github.com/compforge/baton/blob/main/docs/plugin.md`
- `plugins/reqloop/AGENTS.md` — `compforge/reqloop` 的领域边界、代码地图与设计索引
