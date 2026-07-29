# ReqLoop

ReqLoop owns requirement-level coordination outside Baton core. `/requirements`
lists provider-neutral requirements through a `RequirementConnector`; selecting
one reads its normalized detail. The first concrete provider is Meego.

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

```json
{
  "version": 1,
  "requirements": {
    "llmops": {
      "provider": "meego",
      "projectKey": "<Meegle project key>",
      "userKey": "<optional Meegle user_key>",
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
      "type": "github"
    },
    "gitlab.example.com": {
      "type": "gitlab"
    },
    "github-work-alias": {
      "type": "github",
      "api_host": "github.example.com"
    }
  }
}
```

`categories` defaults to `["story", "issue"]`. Configuration is runtime data,
not part of the PluginPackage, and must not be committed to this repository.
When `userKey` is present, `/requirements` returns only work items where that
user is a current participant; omitting it preserves the unfiltered behavior.
Use `meegle user me` to read your own `user_key`, or resolve another person by
name or email with
`meegle user search --user-keys "<name-or-email>" --project-key <projectKey>`.
The `forges` shape follows devloop: its map key is the PullRequest `source`,
explicit `type` wins, `github.com` and `github.*` infer GitHub, and other hosts
default to GitLab. `api_host` points an origin alias at the real API host.
Tokens use `GITHUB_TOKEN`, then `GH_TOKEN`, for GitHub and `GITLAB_TOKEN` for
GitLab; a per-forge `token` field is the fallback.

## Resources and flow

ReqLoop owns four provider-neutral Resources:

- `Workspace` — the BatonSession working directory and its discovered checkouts.
- `Repository` — one external repository currently in the observation scope.
- `PullRequest` — a GitHub PR or GitLab MR and its delivery/review state.
- `Requirement` — a selected requirement and the aggregate progress of its
  associated PullRequests.

The main data flow is:

```text
BatonSession cwd → Workspace → Repository → PullRequest
/requirements   → Requirement ← associated PullRequests
Forge/devloop   → latest observations → Resource status → Board / context
```

Controllers keep these Resources aligned with the filesystem, Forge,
requirement platform, and devloop review ledger. When user judgment is needed,
ReqLoop opens a durable Interaction; accepted decisions can become a
`proposed-input` for the current Harness. ReqLoop does not directly drive a
Harness or mutate external Requirement state. The Board currently presents only
active Requirements and unlinked active PullRequests; PullRequest and
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
version:  0.2.5
```

Install this Marketplace in Baton, install `compforge/reqloop`, then enable it
for the BatonSession that owns the repository.

---

ReqLoop 在 Baton core 之外拥有需求级闭环，核心有四种 Resource：

- `Workspace`：当前 BatonSession 的工作目录及其中发现的 checkout；
- `Repository`：进入当前观察范围的外部仓库；
- `PullRequest`：GitHub PR / GitLab MR 及其交付、review 状态；
- `Requirement`：用户选择的需求，以及关联 PullRequest 的聚合进度。

整体数据流与控制流如下：

```text
BatonSession cwd → Workspace → Repository → PullRequest
/requirements   → Requirement ← 关联的 PullRequests
Forge / devloop / 需求平台 → 最新观察 → Resource status → Board / context
需要用户判断 → durable Interaction → Resource status / proposed-input
```

Controller 负责让本地 Resource 与文件系统、代码平台、需求平台及 devloop review 结果持续收敛。
ReqLoop 不直接驱动 Harness，也暂不代用户修改外部 Requirement。领域模型、reconcile、集成
边界与长期方向见 [ReqLoop 架构索引](./AGENTS.md)。

Forge 准入与观察会使用 ReqLoop 对 devloop 原始工具活动的解释：明确的文件写入占优时，
Source 才扩张 PR/MR 集合并提高观察频率；无活动或以读取为主时不扩张集合，已有
PullRequest 仍以较低频率继续收敛。Connector 遇到限流会按服务端 retry 窗口在本地退避。
