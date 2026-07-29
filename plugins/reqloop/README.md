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
ReqLoop opens a durable Interaction; an accepted review can become a
`proposed-input` for the current Harness. ReqLoop does not directly drive a
Harness or mutate external Requirement state. The Board currently presents
only active Requirements and unlinked active PullRequests; PullRequest cards
link to the Forge and show the external title on a single marquee line only
when it overflows. Workspace and Repository remain internal observation
Resources.

Forge polling is activity-aware. Devloop records one rolling hour of raw
tool-call events in each checkout's `.devloop/tool-calls.jsonl`; ReqLoop owns
the interpretation. Explicit file-write dominance enables frequent discovery
and 30-second observation. Missing or read-heavy timelines skip collection
discovery while already admitted PullRequests continue converging every five
minutes. Rate-limit responses honor the provider retry window and pause locally
instead of repeatedly consuming the same API.

See [the Requirement Loop design](../../docs/reqloop.md) for lifecycle,
reconciliation, and recovery details.

```text
pluginId: compforge/reqloop
version:  0.2.4
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
需要用户判断 → durable Interaction → proposed-input → 当前 Harness
```

Controller 负责让本地 Resource 与文件系统、代码平台、需求平台及 devloop review 结果持续收敛。
ReqLoop 不直接驱动 Harness，也暂不代用户修改外部 Requirement。生命周期、reconcile 与恢复细节
见 [Requirement Loop 设计](../../docs/reqloop.md)。

Forge 观察会读取各 repo 的 `.devloop/tool-calls.jsonl` 最近一小时窗口：明确的文件写入次数
多于读取次数时，Source 才发现新的 PR/MR，已准入 PullRequest 每 30 秒观察一次；无时间线或
以读取为主时不扩张集合，已有 PullRequest 降频为每 5 分钟观察一次。Connector 遇到限流会按
服务端 retry 窗口在本地退避。
