# Hello Counter

Hello Counter is a Baton PluginPackage that demonstrates:

- Registering custom PluginResource (`CounterState`)
- Watching builtin resources (`baton.turn`)
- Maintaining state across turns
- Proposing UI input based on plugin logic

```text
pluginId: qiankunli/hello-counter
version:  0.0.2
```

## Features

- **Turn counting**: Tracks the total number of user questions in a Baton session
- **State persistence**: Uses PluginResource to maintain counter state
- **Event watching**: Demonstrates watching builtin `baton.turn` events
- **Proposed input**: Shows how plugins can suggest UI actions

Add this repository as a Baton Marketplace, then open `/plugins` to discover, inspect, and install Hello Counter.

---

Hello Counter 是一个 Baton PluginPackage 演示插件，展示了：

- 注册自定义 PluginResource（`CounterState`）
- 监听内置资源（`baton.turn`）
- 跨轮次维护状态
- 基于插件逻辑提出 UI 输入建议
