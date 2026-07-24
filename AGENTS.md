# reqloop

## 项目定位与边界

reqloop 是 Baton 的 Requirement Loop Plugin Marketplace，不是单 Plugin 仓库。仓库根只负责
Marketplace 索引、跨 Plugin 约定和开发工具；`plugins/` 下每个子目录是一份可独立安装、
版本化和启用的 Baton Plugin。

reqloop 中的 Plugin 可以分别处理需求、交付、部署、评测或其他长期闭环，但 Requirement、
Deployment、Verdict 等领域类型仍归拥有它们的 Plugin，不进入 Baton core。Plugin 只依赖
Baton 发布的公共 Plugin API，不能相对路径导入 Baton 源码或持有其内部 Store、Controller、
Harness runtime。

## 代码地图与核心模块

```text
reqloop/
├── .baton-plugin/
│   └── marketplace.json   # Baton Marketplace 索引
├── plugins/               # Plugin 域：一份子目录对应一个独立 PluginPackage
│   └── <plugin-name>/
│       ├── .baton-plugin/
│       │   └── plugin.json
│       ├── src/
│       ├── tests/
│       ├── package.json
│       └── README.md
├── CONTRIBUTING.md        # 新 Plugin 接入与索引规则
└── README.md              # Marketplace 用户入口
```

不要为尚未出现的能力预建 `common/`、`utils/` 或共享 SDK。真实的跨 Plugin 稳定代码出现后，再
提升到根级 `packages/`，并保持领域对象仍由各 Plugin 自己拥有。

## 关键约定

1. Marketplace 只负责发现和交付不可变的 PluginPackage；PluginInstance、Binding、Resource、
   Proposal 和调度状态归 BatonSession 及 Baton Manager。
2. 每个 Plugin 的 manifest 声明可审阅的 Contribution 和权限，运行期注册必须与声明一致；
   Command、Resource 等变体统一收束在 PluginContribution 下。
3. Plugin 的领域逻辑与外部 Connector 分离：Reconciler 负责根据 `spec/status` 收敛状态，
   Connector 只负责协议调用和 DTO 映射，不能反向拥有 loop。
4. 本地开发可以使用 link 来源，但发布版本必须不可变；来源 provenance 不进入 `pluginId` 或
   PluginInstance 身份。
5. 新 Plugin 必须放进 `plugins/`，同时更新 Marketplace 索引和根 README；具体配置、限制和
   使用方式留在该 Plugin 自己的 README。

## References

- `README.md` — Marketplace 定位、目标使用流程和 Plugin 列表
- `CONTRIBUTING.md` — 新增 Plugin 的目录、manifest 与验证要求
- Baton Plugin 设计：
  `https://github.com/qiankunli/baton/blob/main/docs/plugin.md`
- reqloop 领域设计：
  `https://github.com/qiankunli/baton/blob/main/docs/reqloop.md`
