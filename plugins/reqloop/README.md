# ReqLoop

ReqLoop owns requirement-level coordination outside Baton core. `/requirements`
lists provider-neutral requirements through a `RequirementConnector`; selecting
one reads its normalized detail. The first concrete provider is Meego.

```text
/requirements
  → RequirementConnector.list()
  → Baton picker
  → RequirementConnector.get(selected source + category + id)
  → requirement detail
```

Provider categories such as `story` and `issue` are display metadata to
ReqLoop. `source` identifies one configured Connector; the selected
`source + category + id` identity routes detail reads without interpreting
provider categories.

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
asks whether the user wants to inspect the result. Only an affirmative answer
produces the Harness follow-up input.

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
stop polling. Review-thread lookup degrades to `unknown` when an instance or
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
  → user confirms
  → proposed-input
  → user asks the current Harness to inspect review comments
```

The Controller periodically rereads the authoritative ledger through its
Connector. Devloop writes the full `source + repository + number` identity;
the same PullRequest status persists the observed review key for restart-safe
deduplication. Results from another worktree, an older commit, or a local
review without an open PR/MR are ignored.

```text
pluginId: qiankunli/reqloop
version:  0.1.7
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
结束并停止轮询。devloop review 也通过完整 PullRequest identity 汇入同一个 Resource。

RequirementController 会通过配置的 Connector 定时刷新活跃需求。若至少存在一个关联 PR、所有
关联 PR 都已 merged，且 review thread 状态均为 none 或 resolved，它会去重吐出 toast，提醒用户前往
需求平台关闭需求；当前阶段不会代用户修改外部需求状态。

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
`interaction` 询问用户是否查看；只有用户确认后才生成 `proposed-input`，提醒当前 Harness
检查 review comments。选择“暂不查看”不会驱动 Harness。

Controller 由 cron Source 定时唤醒，并通过 Connector 重读权威 ledger；Resource status 持久记录已观察 review
identity，因此重启后仍能去重；其他 worktree 或旧 commit 的结果不会串入当前会话。
