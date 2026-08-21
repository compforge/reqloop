# ReqLoop releases

Current version: `0.3.2`

## 0.3.2

- Add Product as the owner of each global deployment catalog.
- Scope Component and Environment identities by Product and reject Services
  whose Component and Environment belong to different Products.
- Nest deployment catalog configuration under `products` and require config
  format version `2`.
- Move deployment Resources to `reqloop.baton.dev/v1alpha2` so legacy global
  Environment identities cannot collide with Product-scoped Resources.

## 0.3.1

- Clear stale deployment revision, artifact, workload, and object observations
  whenever a Service becomes unavailable.

## 0.3.0

- Add global Component, Environment, and Service Resources for deployment
  visibility across Projects and Sessions.
- Model Kubernetes as an explicit Environment target and observe configured
  Deployment, Service, and ConfigMap objects through bounded, read-only kubectl
  calls.
- Project deployed revision, artifacts, workload readiness, and object versions
  into Service status and the Baton Board.

## 0.2.17

- Require `@compforge/baton-plugin` 0.8.1 and move project scope from the
  PluginPackage to each Resource observation and operation.
- Route Source emissions, watches, reads, and deletes through the stable
  `v1/project/<project-id>` namespace so same-named Resources cannot cross
  project boundaries.

## 0.2.16

- Declare the project-scoped `v1/project` Baton namespace so multiple Sessions
  in the same checkout share one Binding and one Plugin Worker.

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
