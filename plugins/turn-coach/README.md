# Turn Coach

Turn Coach is a small Baton PluginPackage that exercises the real runtime path
without depending on an external service:

```text
pluginId: qiankunli/turn-coach
version:  0.0.3
```

It observes the read-only `baton.turn` Baton-owned Resource, keeps a
`TurnCoachState/main` Resource for the current BatonSession, and returns a
`proposed-input` after each turn completed while the Plugin is enabled.
Submitting the proposal asks the active Harness to check the previous result for
missing work or risks and choose one concrete next step.

Replay is intentional. Turns older than the first activation boundary are
ignored, so enabling the Plugin in a long-running session does not flood the
composer. Reconciliation may see later turns again after Baton restarts, so
status updates are guarded by the turn's ledger revision while the same
deterministic proposal is returned again. Baton then restores or deduplicates
that proposal using its durable identity.

## Try it

Register this repository as a Marketplace, install `qiankunli/turn-coach`, then
enable **Turn Coach** for the current session from `/plugins`. Complete any
Codex or Claude turn and inspect the proposed input in the composer.

This Package has no Connector, credentials, network access, or external side
effects. It is intended as the first canary when validating install, enable,
restart, update, rollback, and disable behavior.

---

Turn Coach 是一份不依赖外部系统的 Baton Plugin canary。它监听只读的
`baton.turn`，用 `TurnCoachState/main` 保存当前 Session 的处理水位，并在启用后的每个 turn
完成时生成一条可提交或丢弃的 `proposed-input`。重复 replay 不会倒退状态，同一份建议由
Baton 的持久 Proposal 身份负责恢复和去重。
