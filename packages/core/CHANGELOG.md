# nominee

## 2.0.1

### Patch Changes

- Release 2.0.1 and fix unintended major version bumps.

  Two things in one release:

  1. **Unblock publishing.** The `2.0.0` version number was burned on npm for
     `nominee-ai`, `nominee-eve`, and `nominee-auth0` (published then unpublished
     on 2026-06-20), so npm permanently rejects republishing it and the Release
     workflow stayed red. Bumping to `2.0.1` publishes a fresh, clean version.

  2. **Fix the versioning.** `2.0.0` itself was an _accident_: a single
     `nominee-auth0: minor` changeset got escalated to a whole-group **major** by
     changesets' `fixed`-group behavior. The config now uses `linked` instead of
     `fixed`, so the packages still share a version line but a `minor` changeset
     bumps a minor and a `patch` bumps a patch — no surprise majors.

## 2.0.0

## 1.1.0

### Minor Changes

- Add sub-agent delegation. `delegate(actor)` returns a child Nominee that shares the parent's token cache and audit stream but records an extended identity chain, so a delegated action is attributed to `user → orchestrator → sub-agent`. `exchange({ user, connection, actor, scopes })` performs an RFC 8693 token exchange for a downscoped token bound to a sub-agent (requires a strategy that implements `exchange`), emitting `token.exchanged` with the chain.

## 1.0.0

### Minor Changes

- f1593cf: Approval requests passed to `onApprovalRequest` now carry `approve()`, `deny()`, and `resolve(decision)` methods, so you can settle them inline without capturing the `Nominee` instance (no more self-reference / type-annotation dance). `resolveApproval(id, decision)` still works.
- Add single-flight refresh coalescing and `invalidate()`.

  `token()` now deduplicates concurrent cache-miss calls — N parallel calls share one fetch instead of stampeding the token endpoint. The in-flight promise map is cleaned up in `finally` so a failed refresh never blocks the next attempt.

  `invalidate(user, connection)` drops the cached entry and emits a `token.invalidated` audit event. Use it when a token is known-bad (e.g. a 401 came back from the API) to force a fresh fetch on the next `token()` call.
