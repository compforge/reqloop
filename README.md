[简体中文](./README.zh-CN.md)

# reqloop

reqloop is the official [Baton](https://github.com/compforge/baton) marketplace
for requirement-level engineering loops. It is a multi-plugin repository: every
directory under `plugins/` is an independently versioned Baton PluginPackage,
while the repository root owns only marketplace discovery and shared
plugin authoring rules.

## Architecture at a glance

A Baton Plugin coordinates a long-running domain loop, but it does not call a
Harness directly. It proposes or submits scoped work through Baton's normal
input, context, permission, and routing path. Harnesses provide intelligent
execution capabilities, while Harness Plugins such as devloop constrain the
development loop inside a Harness.

![Baton, Plugin, and Harness](./docs/baton-plugin-harness.svg)

ReqLoop currently connects requirement, Forge, and devloop observations and
turns their state and durable user decisions into Resources. The workflow below
also shows the longer-term direction toward delivery, evaluation, and
explicitly scoped automation; those stages are not all implemented yet.

![ReqLoop workflow](./docs/reqloop-workflow.svg)

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

The repository grows with Baton's external Plugin host and per-Binding Runner
processes. Hello validates the smallest Package lifecycle; Hello Counter and
Turn Coach exercise Resource/Reconcile, Baton-owned Resource watches, and
durable proposals; ReqLoop coordinates Workspace, Repository, PullRequest, and
Requirement Resources across requirement, Forge, and devloop observations.

## Install and use in Baton

Register this Git repository as a Marketplace and install the Package you need:

```bash
baton plugins marketplace add https://github.com/compforge/reqloop.git
baton plugins install compforge/turn-coach --marketplace reqloop
baton plugins install compforge/reqloop --marketplace reqloop
baton plugins list
```

For local development, replace the Git URL with the path to your checkout:

```bash
baton plugins marketplace add /path/to/reqloop
```

Package installation makes it available to Baton. To use it in a session, start
`baton`, enter `/plugins`, open **Installed**, select the Package, and choose
**Enable in this session**. Turn Coach reviews completed turns and recommends
the next step; ReqLoop observes devloop review completion across Workspace
checkouts, asks the user to accept or ignore actionable comments once, and
proposes a Harness fix only when accepted.

## Repository layout

```text
.baton-plugin/marketplace.json  Marketplace index
plugins/<plugin-name>/          One independently versioned Baton plugin
plugins/reqloop/AGENTS.md       ReqLoop architecture and design index
plugins/reqloop/docs/           ReqLoop domain and reconcile details
docs/baton-plugin-harness.*     Baton Plugin and Harness relationship
docs/reqloop-workflow.*         ReqLoop workflow (SVG and PNG)
CONTRIBUTING.md                 Rules for adding a plugin
AGENTS.md                       Architecture and maintenance constraints
```

Plugin domain models and Connectors stay inside their owning plugin. Baton core
only supplies the generic Package, Instance, Binding, Resource/Controller and
Proposal contracts.

## Plugins

- [Hello](./plugins/hello/README.md) — a minimal `0.1.0` Package for validating
  Marketplace discovery, installation, and loading.
- [Hello Counter](./plugins/hello-counter/README.md) — demonstrates a writable
  Resource combined with a `baton.turn` Controller.
- [Turn Coach](./plugins/turn-coach/README.md) — an end-to-end canary for
  Baton-owned Resource replay, persistent state, and proposed input.
- [ReqLoop](./plugins/reqloop/README.md) — requirement-level coordination
  connecting Workspace, Repository, PullRequest, and Requirement Resources,
  exposing active requirements as Harness context, and aggregating merge and
  review progress on the Board.

See the [ReqLoop architecture](./plugins/reqloop/AGENTS.md) for its domain
model, reconcile flow, integration boundaries, and roadmap.

See [CONTRIBUTING.md](./CONTRIBUTING.md) before adding a plugin.
