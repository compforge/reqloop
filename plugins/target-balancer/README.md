# Target Balancer

Target Balancer assigns a new BatonSession to the least-used eligible target in
the Harness family selected by the user. The binding is written through Baton's
built-in `SessionTargetBinding` Resource before the first prompt is routed, then
kept for the lifetime of that session so Harness-side context caches remain
effective.

For example, two Codex accounts can be configured as two targets of the same
Harness family:

```yaml
defaultTarget: codex
targets:
  codex:
    harness: codex
  codex2:
    harness: codex
    env:
      CODEX_HOME: /Users/you/.codex2
```

Install the Package and enable it globally. When the user selects the
conventional `codex` target, the Plugin considers every Ready, eligible `codex`
target and counts bindings owned by active sessions. It chooses the lowest
count, breaking ties by target ID. Selecting `codex2` explicitly always bypasses
balancing.

Target Balancer never auto-discovers a balancing pool. Configure every Harness
family that should be balanced in the Plugin instance config at
`~/.baton/plugin.yaml`:

```yaml
version: 1
plugins:
  compforge/target-balancer@reqloop:
    enabled: true
    version: 0.1.0
    config:
      pools:
        codex: [codex, codex2]
        claude: [claude, claude2]
```

Only active Baton sessions contribute load. The Resource projection remains the
source of truth; the Plugin's global data directory contains only a short-lived
lock used to serialize simultaneous first assignments.

Requires Baton and `@compforge/baton-plugin` 0.8.2 or newer.

---

Target Balancer 在用户仍选择 `codex`、`claude` 等默认 Harness target 的前提下，为新
BatonSession 选择同 Harness family 中当前活跃 Session 使用较少的 target。首次绑定通过
Baton 内置 `SessionTargetBinding` Resource 完成，之后同一 Session 始终复用该 target，以保留
Harness 上下文缓存。只有 `config.pools` 中显式配置的 Harness family 才会参与均衡；显式选择
`codex2` 等具体 target 时不会参与均衡。
