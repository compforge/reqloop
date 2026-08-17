# ReqLoop releases

Current version: `0.2.15`

## 0.2.15

- Require the Baton Plugin 0.6 authoring contract and adopt the renamed
  `HarnessInvocationInput` type.

## 0.2.14

- Adopt the Baton Plugin 0.5 authoring contract: grouped Package registries,
  Requirement Mention resolution, and verb access through `context.verbs`.

## 0.2.10

- Add independent CodeReview Resources backed by devloop review signals and
  Forge comment findings and labels.
- Project pending reviews through their PullRequest Board cards, retaining
  merged PullRequests as lower-priority candidates until review labeling
  completes or expires.

## 0.2.9

- Require `@compforge/baton-plugin` 0.2.4 and adopt its structured logger.
- Keep lifecycle and discovery summaries at `info`, move paths and entity lists
  to `debug`, and report recoverable source failures as structured `warn`
  records.

## 0.2.8

- Add low-noise lifecycle and PullRequest discovery diagnostics.
- Document durable Resource observations and limits on unnecessary external
  API calls.

## 0.2.7

- Enforce configured Meegle participant filtering for Requirement searches,
  including multiple configured accounts.
- Optionally discover only PullRequests authored by configured Forge accounts.
- Rank newer Requirement and PullRequest Board items higher within the same condition.

## 0.2.6

- Keep review findings actionable after a PullRequest has merged.
- Let users close local Requirement tracking after delivery is complete.
- Prompt users to hand merge conflicts back to the Harness for resolution.
- Support filtering Meegle requirements by participant.
- Keep Requirement Board items linked to their external source.
