[简体中文](./README.zh-CN.md)

# reqloop

reqloop is the official Baton marketplace for requirement-level engineering
loops. It is a multi-plugin repository: every top-level plugin directory is an
independently versioned Baton PluginPackage, while the repository root owns
only marketplace discovery and shared contribution rules.

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

The repository is being bootstrapped together with Baton's external plugin and
marketplace support. No plugin is published from this marketplace yet. The
first implementation will exercise the complete local development flow before
remote installation and marketplace updates are added.

## Repository layout

```text
.baton-plugin/marketplace.json  Marketplace index
<plugin-name>/                  One independently versioned Baton plugin
CONTRIBUTING.md                 Rules for adding a plugin
AGENTS.md                       Architecture and maintenance constraints
```

Plugin domain models and Connectors stay inside their owning plugin. Baton core
only supplies the generic Package, Instance, Binding, Contribution,
Resource/Reconcile and Proposal contracts.

## Plugins

No plugins have been published yet.

See [CONTRIBUTING.md](./CONTRIBUTING.md) before adding the first plugin.

