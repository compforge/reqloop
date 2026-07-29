# Hello Counter

Hello Counter is a Baton PluginPackage that demonstrates:

- Registering a custom Resource Controller (`CounterState`)
- Watching Baton-owned resources (`baton.turn`)
- Maintaining state across turns
- Presenting current state on Baton's optional Board sidecar
- Proposing UI input based on plugin logic

```text
pluginId: qiankunli/hello-counter
version:  0.1.0
```

## Features

- **Turn counting**: Tracks the total number of user questions in a Baton session
- **State persistence**: Uses a Resource to maintain counter state
- **Event watching**: Demonstrates observing Baton-owned `baton.turn` Resources
- **Board presentation**: Shows the count and latest question in Baton's optional right sidecar
- **Proposed input**: Shows how plugins can suggest UI actions

Add this repository as a Baton Marketplace, then open `/plugins` to discover, inspect, and install Hello Counter.

---

Hello Counter 是一个 Baton PluginPackage 演示插件，展示了：

- 注册自定义 Resource Controller（`CounterState`）
- 监听 Baton-owned Resource（`baton.turn`）
- 跨轮次维护状态
- 把当前计数展示到 Baton 的可选右侧 Board
- 基于插件逻辑提出 UI 输入建议
