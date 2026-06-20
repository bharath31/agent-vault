# standalone-node — nominee core, no framework

The smallest end-to-end demo of the core API: fetch a token, see it cached and
refreshed, gate an action behind approval, and watch the audit stream. No
provider, no signup — it uses a mock function strategy.

## Run

```bash
pnpm install            # from the repo root
pnpm --filter standalone-node dev
```

## What it shows

- **Fresh-at-call-time tokens** — `nominee.token()` returns a cached token while
  it's still valid, and re-fetches transparently once it isn't.
- **Human-in-the-loop** — `nominee.approve()` blocks until a decision; the demo
  simulates a webhook calling `nominee.resolveApproval()`.
- **Audit** — every privileged op prints an event with the `user → agent → tool` chain.

This is pure core (`nominee`). To make it real, swap the mock strategy for
`OAuth2(...)` (tokens you already have) or `Auth0(...)` (managed) — nothing else changes.
