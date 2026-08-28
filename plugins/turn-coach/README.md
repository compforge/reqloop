# Turn Coach

Turn Coach is a small Baton PluginPackage that exercises the real host path
without depending on an external service:

```text
pluginId: compforge/turn-coach
version:  0.1.0
```

It observes the read-only `baton.turn` Baton-owned Resource, keeps a
`TurnCoachState/main` Resource for the current BatonSession, and requests an
editable draft through `ReconcileContext.verbs.draft` after each turn completed
while the Plugin is enabled. Submitting the draft asks the active Harness to
check the previous result for missing work or risks and choose one concrete next
step.

Replay is intentional. Turns older than the first activation boundary are
ignored, so enabling the Plugin in a long-running session does not flood the
composer. Reconciliation may see later turns again after Baton restarts, so the
turn's ledger revision is persisted before requesting the live draft
continuation. Replay therefore does not duplicate a suggestion.

## Try it

Register this repository as a Marketplace, install `compforge/turn-coach`, then
enable **Turn Coach** for the current session from `/plugins`. Complete any
Codex or Claude turn and inspect the editable draft in the composer.

This Package has no Connector, credentials, network access, or external side
effects. It is intended as the first canary when validating install, enable,
restart, update, rollback, and disable behavior.

---

Turn Coach 是一份不依赖外部系统的 Baton Plugin canary。它监听只读的
`baton.turn`，用 `TurnCoachState/main` 保存当前 Session 的处理水位，并在启用后的每个 turn
完成时通过 `ReconcileContext.verbs.draft` 生成一条可提交或丢弃的建议。处理水位会在请求
draft 前持久化，因此重复 replay 不会倒退状态或重复生成建议。
