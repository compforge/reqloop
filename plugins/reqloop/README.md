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
only source routing from `~/.baton/plugins/reqloop.json`:

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

`categories` defaults to `["story", "issue"]`. This temporary standalone file
is not part of the PluginPackage and must not be committed to this repository.
The `forges` shape follows devloop: its map key is the PullRequest `source`,
explicit `type` wins, `github.com` and `github.*` infer GitHub, and other hosts
default to GitLab. `api_host` points an origin alias at the real API host.
Tokens use `GITHUB_TOKEN`, then `GH_TOKEN`, for GitHub and `GITLAB_TOKEN` for
GitLab; a per-forge `token` field is the fallback.

ReqLoop also observes devloop's append-only review ledger. When the current
checkout's review completes with findings, file failures, or an error, it first
asks the user to accept or ignore the result. The choice is persisted once per
review observation; only `accept` produces a Harness follow-up that evaluates
and fixes real findings.

ReqLoop owns a provider-neutral `reqloop.pull-request` Resource for GitHub PRs
and GitLab MRs. Its immutable spec identifies `source + repository + number`;
status records lifecycle, review-thread state and activity, mergeability,
optional Requirement association, and observation time. Every Controller cron Source
first calls `ForgeConnector.list()` to
materialize missing PullRequest Resources, then keyed reconciliation calls
`get()` to refresh each PullRequest. `GitHubForgeConnector` and
`GitLabForgeConnector` provide both operations. Selecting `/requirements`
materializes a stable `reqloop.requirement` Resource. An open PullRequest is
shown on the Board while standalone. Linking it to a Requirement keeps the
PullRequest Resource independent but presents the Requirement as the primary
Board item. Merged PullRequests leave the Board and
stop polling; closed PullRequests are neither discovered nor polled.
Requirement cards summarize linked PR lifecycle, conflicts, and unresolved
review threads. Review-thread lookup degrades to `unknown` when an instance or
token does not expose that API, and ordinary conversation comments are never
treated as unresolved review threads.

`RequirementController` refreshes active Requirements from their configured
Connector. When at least one linked PullRequest exists, all linked
PullRequests are merged, and every review-thread state is `none` or `resolved`, it
shows a deduplicated toast asking the user to close the Requirement in its
source platform. ReqLoop does not mutate external Requirement state yet.

```text
devloop review-history.jsonl
  → DevloopReviewConnector
  → matching reqloop.pull-request status + Controller
  → durable Interaction
  → user chooses accept or ignore once
  → proposed-input
  → current Harness evaluates and fixes real review comments
```

The Controller periodically rereads the authoritative ledger through its
Connector. Devloop writes the full `source + repository + number` identity;
the same PullRequest status persists the observed review key for restart-safe
deduplication. Results from another worktree, an older commit, or a local
review without an open PR/MR are ignored.

```text
pluginId: qiankunli/reqloop
version:  0.1.9
```

Install this Marketplace in Baton, install `qiankunli/reqloop`, then enable it
for the BatonSession that owns the repository.

---

ReqLoop 在 Baton core 之外拥有需求级闭环。`/requirements` 通过
`RequirementConnector` 展示平台无关的需求列表，选中后读取归一化详情；首个具体平台将接
Meego。代码平台按同样边界接 `ForgeConnector`，参考 devloop 的 provider-neutral Forge 模型，
但不导入其实现。PullRequestController 的 cron Source 先通过 Connector `list()` 创建缺失
`reqloop.pull-request` Resource，再由逐 Resource reconcile 调用 `get()` 刷新生命周期、review
thread、merge conflict 和 review activity fingerprint。`/requirements` 选中的需求会物化为
稳定的 `reqloop.requirement` Resource。孤立且活跃的 PullRequest 会单独显示在 Board；关联
Requirement 后仍保留独立 Resource，但 Board 以 Requirement 为主展示。merged 后生命周期
结束并停止轮询；closed PullRequest 不再发现或轮询。Requirement 卡片会汇总关联 PR 的生命周期、
merge conflict 和 unresolved review thread。devloop review 也通过完整 PullRequest identity
汇入同一个 Resource。

RequirementController 会通过配置的 Connector 定时刷新活跃需求。若至少存在一个关联 PR、所有
关联 PR 都已 merged，且 review thread 状态均为 none 或 resolved，它会去重吐出 toast，提醒用户前往
需求平台关闭需求；当前阶段不会代用户修改外部需求状态。

`/requirements` Picker 带搜索框；Baton 对输入做防抖并丢弃过期响应，reqloop 将最新查询词
交给每个 RequirementConnector。当前使用有界结果集，不做分页；零结果仍保持
Picker 打开，方便继续修改查询。

已选择并物化的活跃 Requirement 也会出现在 Baton 的 `@` 补全中，分组为
`reqloop@requirement`。搜索只读取当前 BatonSession 的 Requirement Resource，不会随输入调用
Meego 或其它外部平台；选中后只向本次 Harness turn 注入归一化的需求上下文。

`requirements` 是以 source 为 key 的具名 Connector 集合，存在即生效，允许同时配置多个需求
平台或同一平台的多个实例。Meego 的 `story`、`issue` 等分类由 Connector 填入 `category`。
reqloop 使用 `source` 路由，并将 `category + id` 原样交回 Connector，不根据分类分支。Meego
Connector 通过公开发布的 Meegle CLI 读取需求；OAuth token 由 CLI 的系统钥匙串/profile
管理，不进入 reqloop 配置、PluginPackage 或公开仓。`~/.baton/plugins/reqloop.json` 只保存
source 对应的 `projectKey`、可选 profile 和 category 列表。`forges` 以 host/source 为 key，
支持显式 `type` 与 SSH alias 对应的 `api_host`；GitHub 优先读取 `GITHUB_TOKEN` / `GH_TOKEN`，
GitLab 优先读取 `GITLAB_TOKEN`，配置内 `token` 仅作为 fallback。

现有 review 能力会观察 devloop 的追加式 review ledger；
当前 checkout 的 review 出现 finding、文件失败或 error 时，它先发起持久
`interaction` 让用户选择 accept 或 ignore；选择按 review identity 写入 PullRequest status，
无论哪种选择都不再重复提醒。只有 accept 才生成 `proposed-input`，让当前 Harness 判断并修复
真实问题。

Controller 由 cron Source 定时唤醒，并通过 Connector 重读权威 ledger；Resource status 持久记录已观察 review
identity，因此重启后仍能去重；其他 worktree 或旧 commit 的结果不会串入当前会话。
