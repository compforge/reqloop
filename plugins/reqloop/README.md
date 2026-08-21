# ReqLoop

ReqLoop owns requirement and deployment coordination outside Baton core.
`/requirements` lists provider-neutral requirements through a
`RequirementConnector`; selecting one reads its normalized detail. The first
concrete requirement provider is Meego. A global deployment catalog also maps
each Product's Components into its Environments and observes their Service
instances; Kubernetes is the first supported Environment target.

```text
/requirements
  → search field
  → RequirementConnector.list({ text, limit })
  → Baton picker
  → RequirementConnector.get(selected source + category + id)
  → requirement detail
```

Provider categories such as `story` and `issue` are display metadata to
ReqLoop. `source` identifies one configured Connector; the selected
`source + category + id` identity routes detail reads without interpreting
provider categories.

The picker keeps its search field open even when no requirement matches.
Baton debounces query changes and discards stale responses; ReqLoop forwards
the latest text to every configured `RequirementConnector`. The current command
uses a bounded result set and does not paginate.

Selected Requirements are also available from Baton's `@` completion under the
`reqloop@requirement` group. This search reads only active Requirement Resources
already materialized in the current BatonSession, so typing does not call Meego
or another external platform. Selecting one contributes its normalized detail
to that Harness turn.

The first Meego Connector uses the public
[`@lark-project/meegle`](https://www.npmjs.com/package/@lark-project/meegle)
CLI. Install and log in once:

```bash
npx @lark-project/meegle@latest install
meegle auth login --host <your-meegle-host>
```

OAuth tokens stay in the Meegle CLI's keychain-backed profile. ReqLoop reads
Connector configuration from `config.json` under the Plugin's global, Project,
and Session data directories. The narrower scope recursively overrides the
broader scope; Instance data does not carry configuration. A typical global
file is `~/.baton/plugins/compforge%2Freqloop/config.json`:

Copy [`config.json.example`](./config.json.example) for a complete, valid JSON
template covering every supported field:

```bash
cp plugins/reqloop/config.json.example \
  ~/.baton/plugins/compforge%2Freqloop/config.json
```

```json
{
  "version": 2,
  "requirements": {
    "llmops": {
      "provider": "meego",
      "projectKey": "<Meegle project key>",
      "userKeys": ["<optional Meegle user_key>"],
      "categories": ["story", "issue"]
    },
    "another-meego-source": {
      "provider": "meego",
      "projectKey": "<another project key>",
      "profile": "<optional Meegle CLI profile>"
    },
    "another-source": {
      "provider": "<another provider>",
      "configuration": "<provider-owned fields>"
    }
  },
  "forges": {
    "github.com": {
      "type": "github",
      "uids": ["<optional GitHub login or user ID>"]
    },
    "gitlab.example.com": {
      "type": "gitlab",
      "uids": ["<optional GitLab username or user ID>"]
    },
    "github-work-alias": {
      "type": "github",
      "api_host": "github.example.com"
    }
  },
  "products": {
    "agentsphere": {
      "displayName": "AgentSphere",
      "components": {
        "chat-server": {
          "displayName": "Chat Server",
          "repository": {
            "forge": "github.com",
            "path": "compforge/chat-server"
          }
        }
      },
      "environments": {
        "dev": {
          "displayName": "Development",
          "targets": [{
            "kind": "kubernetes",
            "name": "primary",
            "source": "dev-cluster",
            "cluster": "dev.example"
          }]
        }
      },
      "services": {
        "chat-server-dev": {
          "component": "chat-server",
          "environment": "dev",
          "deployment": {
            "kind": "kubernetes",
            "target": "primary",
            "namespace": "agentsphere",
            "deployments": ["chat-server"],
            "services": ["chat-server"],
            "configMaps": ["chat-server"]
          },
          "url": "https://dev.example/chat"
        }
      }
    }
  },
  "kubernetes": {
    "dev-cluster": {
      "kubeconfig": "/absolute/path/to/dev.kubeconfig",
      "context": "dev"
    }
  }
}
```

The map keys under `requirements` are stable Requirement Connector `source`
identities; keys under `forges` are stable Forge Connector identities.
Placeholder values in the example must be replaced or removed before use.

| Field | Purpose |
| --- | --- |
| `version` | ReqLoop configuration format version; currently `2`. |
| `requirements.<source>` | Stable Requirement Connector identity. |
| `provider` | Connector provider; Requirement currently supports `meego`. |
| `projectKey` | Meegle project whose work items are queried. |
| `profile` | Optional Meegle CLI profile. |
| `userKeys` | Optional Meegle participant accounts; any match is admitted. |
| `categories` | Meegle work-item categories; defaults to `story` and `issue`. |
| `forges.<forge>` | Stable Forge Connector identity, normally the Git host. |
| `type` | Forge provider, `github` or `gitlab`; otherwise inferred from host. |
| `api_host` | Optional real API host when the Forge key is an alias. |
| `uids` | Optional PR/MR author accounts; any match is admitted. |
| `token` | Optional fallback after the provider token environment variables. |
| `products.<name>` | Stable Product identity and owner of its deployment catalog. |
| `products.<name>.components.<name>` | Static Component identity within the Product. |
| `products.<name>.components.<name>.repository` | Optional primary code repository, identified by the same `forge` and provider-neutral `path` used by Repository and PullRequest Resources. |
| `products.<name>.environments.<name>.targets` | Deployment infrastructure owned by a Product Environment; targets may be omitted for a non-Kubernetes Environment. |
| `products.<name>.services.<key>` | One Component instance in an Environment of the same Product and its concrete deployment mapping. |
| `kubernetes.<source>` | Kubernetes access keyed by the target `source`; `kubeconfig` is required and `context` is optional. |

`categories` defaults to `["story", "issue"]`. Configuration is external data,
not part of the PluginPackage, and must not be committed to this repository.
When `userKeys` is present, `/requirements` returns only work items where any
configured user is a participant; omitting it preserves the unfiltered behavior.
Use `meegle user me` to read your own `user_key`, or resolve another person by
name or email with
`meegle user search --user-keys "<name-or-email>" --project-key <projectKey>`.
The `forges` shape follows devloop: its map key is the PullRequest `forge`,
explicit `type` wins, `github.com` and `github.*` infer GitHub, and other hosts
default to GitLab. `api_host` points an origin alias at the real API host.
When `uids` is present, Forge discovery admits only PullRequests authored by
any configured provider account; omitting it preserves unfiltered discovery.
Tokens use `GITHUB_TOKEN`, then `GH_TOKEN`, for GitHub and `GITLAB_TOKEN` for
GitLab; a per-forge `token` field is the fallback.

Deployment catalog configuration is read only from the Plugin's global
`config.json`, because Products, Components, Environments, clusters, and Services are
shared facts rather than Session-local state. Install `kubectl` and provide an
explicit kubeconfig for every configured Kubernetes source. ReqLoop performs
bounded, read-only `kubectl version` and `kubectl get` calls; it does not apply,
roll out, restart, or delete workloads.

## Resources and flow

ReqLoop owns nine Resources across two scopes:

- Global `v1` deployment catalog:
  - `Product` — the stable owner of Components, Environments, and Services.
  - `Component` — a static software unit within a Product, optionally linked to its primary code Repository.
  - `Environment` — a Product's logical deployment environment and its infrastructure
    targets; Kubernetes is one explicit target kind, not the definition of an
    Environment.
  - `Service` — one Component instance in one Environment, including its
    Deployment, Service, and ConfigMap mapping and latest observed revision.
- Project `v1/project/<project-id>` development loop:
  - `Workspace` — the BatonSession working directory and its discovered checkouts.
  - `Repository` — one external repository currently in the observation scope.
  - `PullRequest` — a GitHub PR or GitLab MR and its Forge state.
  - `CodeReview` — one published devloop AI code-review run associated with a
    PullRequest.
  - `Requirement` — a selected requirement and the aggregate progress of its
    associated PullRequests.

The main data flow is:

```text
Product ─┬→ Component ───────────────┐
         └→ Environment target ──────┴→ Service → Kubernetes observation
                                                     └→ revision / readiness / objects
Component.repository {forge, path} ──matches──▶ Repository.spec.identity
BatonSession cwd → Workspace → Repository → PullRequest
                                            └→ CodeReview
/requirements   → Requirement ← associated PullRequests
Forge/devloop   → latest observations → Resource status → Board / context
```

Controllers keep these Resources aligned with Kubernetes, the filesystem,
Forge, requirement platform, and Forge comments published by devloop. When user
judgment is needed, ReqLoop opens a durable Interaction; accepted decisions can
open a `draft` suggested-input Interaction for the current Harness. The user can
edit and submit that draft, after which the Harness can use
devloop's label-review workflow while ReqLoop observes the resulting
`ccr:label` replies through Forge. ReqLoop does not directly drive a Harness or
mutate external Requirement state. The Board presents Environments, Services,
active Requirements, and PullRequests, projecting a bound actionable CodeReview
and its label progress through the PullRequest card. A merged PullRequest with an
unlabeled review remains a low-priority Board candidate, so active blockers can
still displace it. PullRequest and
Requirement cards link to their external source and show the external title on
a single marquee line only when it overflows. Workspace and Repository remain
internal observation Resources.

Forge admission and observation are activity-aware. ReqLoop interprets
devloop's raw tool activity: explicit file-write dominance enables collection
discovery and a higher observation cadence; missing or read-heavy activity does
not expand the collection, while already admitted PullRequests continue
converging at a lower cadence. Rate-limit responses honor the provider retry
window and pause locally instead of repeatedly consuming the same API.

See [the ReqLoop architecture](./AGENTS.md) for the domain model, reconcile
flow, integration boundaries, and roadmap.

```text
pluginId: compforge/reqloop
```

Install this Marketplace in Baton, install `compforge/reqloop`, then enable it
for the BatonSession that owns the repository.

---

ReqLoop 在 Baton core 之外拥有需求与部署闭环，核心有九种 Resource。全局 `v1` 下包括：

- `Product`：Component、Environment 和 Service 的稳定 owner；
- `Component`：Product 内的静态软件单元，可选登记其主代码仓库；
- `Environment`：Product 的逻辑部署环境及其基础设施 target；Kubernetes 是显式 target 类型，但不等同于
  Environment；
- `Service`：一个 Component 在一个 Environment 中的实例，保存 K8s Deployment、Service、
  ConfigMap 映射以及最近观测的部署版本和就绪状态。

Project namespace 下包括：

- `Workspace`：当前 BatonSession 的工作目录及其中发现的 checkout；
- `Repository`：进入当前观察范围的外部仓库；
- `PullRequest`：GitHub PR / GitLab MR 及其 Forge 状态；
- `CodeReview`：关联 PullRequest 的一次已发布 devloop AI code-review 运行；
- `Requirement`：用户选择的需求，以及关联 PullRequest 的聚合进度。

整体数据流与控制流如下：

```text
Product ─┬→ Component ───────────────┐
         └→ Environment target ──────┴→ Service → Kubernetes observation
                                                     └→ 部署版本 / 就绪度 / 对象版本
Component.repository {forge, path} ──匹配──▶ Repository.spec.identity
BatonSession cwd → Workspace → Repository → PullRequest
                                            └→ CodeReview
/requirements   → Requirement ← 关联的 PullRequests
Forge / devloop / 需求平台 → 最新观察 → Resource status → Board / context
需要用户判断 → `ask` Interaction → Resource status / `draft` Interaction
```

Controller 负责让 Resource 与 Kubernetes、文件系统、代码平台、需求平台及 devloop 发布到
Forge 的 review comments 持续收敛。已绑定 PullRequest 的待处理 CodeReview 及 label 进度跟随 PR
卡片展示；merged PR 可因此继续成为低优先级 Board 候选，但不会挤掉 open merge conflict
等活跃阻塞项。Harness 通过 devloop label-review 写入的 `ccr:label` 回复仍以 Forge comment
为事实源。
ReqLoop 不直接驱动 Harness，也暂不代用户修改外部 Requirement。领域模型、reconcile、集成
边界与长期方向见 [ReqLoop 架构索引](./AGENTS.md)。

Forge 准入与观察会使用 ReqLoop 对 devloop 原始工具活动的解释：明确的文件写入占优时，
Source 才扩张 PR/MR 集合并提高观察频率；无活动或以读取为主时不扩张集合，已有
PullRequest 仍以较低频率继续收敛。Connector 遇到限流会按服务端 retry 窗口在本地退避。
