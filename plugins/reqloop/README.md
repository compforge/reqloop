# ReqLoop

ReqLoop owns requirement-level coordination outside Baton core. Its first
integration observes devloop's append-only review ledger and proposes a
follow-up input when the current checkout's review completes with findings,
file failures, or an error.

```text
devloop review-history.jsonl
  → DevloopReviewConnector
  → reqloop.review-watch Reconciler + requeueAfter
  → proposed-input
  → user asks the current Harness to inspect review comments
```

The Reconciler periodically rereads the authoritative ledger through its
Connector. PluginResource status persists the observed review identity for
restart-safe deduplication. Results from another worktree or an older commit
are ignored.

```text
pluginId: qiankunli/reqloop
version:  0.0.1
```

Install this Marketplace in Baton, install `qiankunli/reqloop`, then enable it
for the BatonSession that owns the repository.

---

ReqLoop 在 Baton core 之外拥有需求级闭环。首个能力会观察 devloop 的追加式 review ledger；
当前 checkout 的 review 出现 finding、文件失败或 error 时，它生成一条 `proposed-input`，
提醒用户让当前 Harness 检查 review comments。

Reconciler 通过 Connector 定时重读权威 ledger，PluginResource status 持久记录已观察 review
identity，因此重启后仍能去重；其他 worktree 或旧 commit 的结果不会串入当前会话。
