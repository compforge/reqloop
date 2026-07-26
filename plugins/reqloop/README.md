# ReqLoop

ReqLoop owns requirement-level coordination outside Baton core. `/requirements`
lists provider-neutral requirements through a `RequirementConnector`; selecting
one reads its normalized detail. The first concrete provider will be Meego.

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
      "provider": "<future provider>",
      "configuration": "<provider-owned fields>"
    }
  }
}
```

`categories` defaults to `["story", "issue"]`. This temporary standalone file
is not part of the PluginPackage and must not be committed to this repository.

ReqLoop also observes devloop's append-only review ledger and proposes a
follow-up input when the current checkout's review completes with findings,
file failures, or an error.

```text
devloop review-history.jsonl
  → DevloopReviewConnector
  → reqloop.review-watch Controller + cron Source
  → proposed-input
  → user asks the current Harness to inspect review comments
```

The Controller periodically rereads the authoritative ledger through its
Connector. Resource status persists the observed review identity for
restart-safe deduplication. Results from another worktree or an older commit
are ignored.

```text
pluginId: qiankunli/reqloop
version:  0.1.3
```

Install this Marketplace in Baton, install `qiankunli/reqloop`, then enable it
for the BatonSession that owns the repository.

---

ReqLoop 在 Baton core 之外拥有需求级闭环。`/requirements` 通过
`RequirementConnector` 展示平台无关的需求列表，选中后读取归一化详情；首个具体平台将接
Meego。代码平台后续按同样边界接 `ForgeConnector`，参考 devloop 的 provider-neutral
Forge 模型，但不导入其实现。

`requirements` 是以 source 为 key 的具名 Connector 集合，存在即生效，允许同时配置多个需求
平台或同一平台的多个实例。Meego 的 `story`、`issue` 等分类由 Connector 填入 `category`。
reqloop 使用 `source` 路由，并将 `category + id` 原样交回 Connector，不根据分类分支。Meego
Connector 通过公开发布的 Meegle CLI 读取需求；OAuth token 由 CLI 的系统钥匙串/profile
管理，不进入 reqloop 配置、PluginPackage 或公开仓。`~/.baton/plugins/reqloop.json` 只保存
source 对应的 `projectKey`、可选 profile 和 category 列表。

现有 review 能力会观察 devloop 的追加式 review ledger；
当前 checkout 的 review 出现 finding、文件失败或 error 时，它生成一条 `proposed-input`，
提醒用户让当前 Harness 检查 review comments。

Controller 由 cron Source 定时唤醒，并通过 Connector 重读权威 ledger；Resource status 持久记录已观察 review
identity，因此重启后仍能去重；其他 worktree 或旧 commit 的结果不会串入当前会话。
