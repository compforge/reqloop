[简体中文](./README.zh-CN.md)

# reqloop

reqloop is the official [Baton](https://github.com/qiankunli/baton) marketplace
for requirement-level engineering loops. It is a multi-plugin repository: every
directory under `plugins/` is an independently versioned Baton PluginPackage,
while the repository root owns only marketplace discovery and shared
contribution rules.

The intended end-to-end development flow is:

```text
develop a plugin
  → build and validate its manifest
  → link the marketplace or plugin into Baton
  → create and enable a PluginInstance in /plugins
  → activate its PluginBinding
  → use its command and Resource/Reconcile workflow
  → restore the same loop after Baton restarts
```

## Status

The repository grows with Baton's external plugin runtime. Hello validates the
smallest Package lifecycle; Hello Counter and Turn Coach exercise
Resource/Reconcile, Builtin Resource watches, and durable proposals; ReqLoop is
the first requirement-loop Package and observes external devloop review state.

## Install and use in Baton

Register this Git repository as a Marketplace and install the Package you need:

```bash
baton plugins marketplace add https://github.com/qiankunli/reqloop.git
baton plugins install qiankunli/turn-coach --marketplace reqloop
baton plugins install qiankunli/reqloop --marketplace reqloop
baton plugins list
```

For local development, replace the Git URL with the path to your checkout:

```bash
baton plugins marketplace add /path/to/reqloop
```

Package installation makes it available to Baton. To use it in a session, start
`baton`, enter `/plugins`, open **Installed**, select the Package, and choose
**Enable in this session**. Turn Coach reviews completed turns and recommends the
next step; ReqLoop observes devloop review completion for the session's current
repository and proposes a Harness follow-up when comments need inspection.

## Repository layout

```text
.baton-plugin/marketplace.json  Marketplace index
plugins/<plugin-name>/          One independently versioned Baton plugin
docs/reqloop.md                 Requirement Loop domain and Connector design
CONTRIBUTING.md                 Rules for adding a plugin
AGENTS.md                       Architecture and maintenance constraints
```

Plugin domain models and Connectors stay inside their owning plugin. Baton core
only supplies the generic Package, Instance, Binding, Contribution,
Resource/Reconcile and Proposal contracts.

## Plugins

- [Hello](./plugins/hello/README.md) — a minimal `0.0.1` Package for validating
  Marketplace discovery, installation, and loading.
- [Hello Counter](./plugins/hello-counter/README.md) — demonstrates a writable
  PluginResource combined with a `baton.turn` watch.
- [Turn Coach](./plugins/turn-coach/README.md) — an end-to-end canary for
  Builtin Resource replay, persistent state, and proposed input.
- [ReqLoop](./plugins/reqloop/README.md) — requirement-level coordination;
  `0.0.1` starts with devloop review completion follow-up.

See the [Requirement Loop design](./docs/reqloop.md) for the domain model,
Connector boundary, and Harness collaboration model.

See [CONTRIBUTING.md](./CONTRIBUTING.md) before adding a plugin.
