# Boost

Choose speed for simple questions and capability for difficult work:

- `/easy` saves your fast/lightweight model and effort as the Target defaults.
- `/hard` saves your capable model and effort as the Target defaults.
- `/easy explain this function` applies the preset, then submits the task as a new turn.

Commands do not guess difficulty or hardcode model names. Boost receives the
effective Target's available models and each model's supported efforts through
Baton's builtin `Target` Resource, then checks your preset against that catalog. Missing or invalid presets
report an error and available choices without submitting the task. Switching
does not interrupt a running turn.

## Install and configure

Requires Baton 0.4.33+ and public Plugin API 0.9.0+. Model discovery and combined
configuration are supported by Codex and Claude. Other Harness adapters must
implement these capabilities before Boost can switch their models.

```bash
baton plugins install compforge/boost --marketplace reqloop
```

In `~/.baton/plugin.yaml` (replace the example model IDs with available ones):

```yaml
version: 1
plugins:
  compforge/boost@reqloop:
    enabled: true
    version: 0.1.0
    config:
      presets:
        easy:
          codex:
            model: your-fast-model
            effort: medium
        hard:
          codex:
            model: your-capable-model
            effort: high
```

`default` follows the Harness default. These commands are shortcuts for `/model`
plus `/effort`: they save the same Target preferences and remain effective for
later turns and Sessions until changed again. They do not change
accounts, rebalance an existing binding, or store a separate active-preset state.

## Optional target balancing

Add `pools` alongside `presets` to spread new sessions across explicitly
configured accounts of the same Harness family:

```yaml
pools:
  codex: [codex, codex2]
```

- Missing `pools`, `pools: {}`, or all-empty pools disables balancing entirely;
  `/easy` and `/hard` remain available.
- `pools.codex: []` disables balancing for that family. Pools are never auto-discovered.
- A new session selecting the conventional family Target (`codex`) is assigned
  to the least-used Ready, eligible Target in its pool; ties use Target ID.
- Explicitly selecting an exact Target bypasses balancing. Existing bindings
  remain stable to preserve Harness-side context caches.
- On a first `/easy` or `/hard`, balancing finishes before model discovery and
  configuration. A trailing task uses that same Target.

Only active Baton sessions contribute load. Baton Resource projections own the
binding truth; Boost's data directory contains only a short-lived assignment lock.

## Migrate from Target Balancer

Disable or uninstall `compforge/target-balancer` before enabling Boost; do not
run both assignment hooks together. Move its `config.pools` into
`compforge/boost@reqloop`, then add presets. Existing Baton-owned session
bindings do not need migration.

Boost 用 `/easy` 在简单问题上选择更快的轻量模型，用 `/hard` 在复杂问题上选择能力更强的模型。
两档分别配置 model 和 effort；账号均衡是独立可选项，省略或清空 `pools` 即可关闭。
