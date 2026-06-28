# eve-agent — nominee with Vercel Eve

An [Eve](https://eve.dev) agent whose `star_repo` tool gets its GitHub token and
human approval from nominee instead of being tied to Vercel Connect. The token is
fetched **fresh at tool-call time**, and the action **pauses for approval** before
it runs.

## Files

```
agent/
  agent.ts            # defineAgent entrypoint
  instructions.md     # system prompt
  tools/star_repo.ts  # nomineeTool(...) — fresh token + approval gate
lib/
  nominee.ts          # one shared Nominee instance (mock strategy + simulated approval)
```

## Run

```bash
pnpm install          # from the repo root
pnpm --filter eve-agent dev
```

Then start a session and ask it to "star vercel/ai". You'll see:

1. nominee fetch a fresh token for `github` at the moment the tool fires,
2. the run **pause for approval** (this demo auto-approves after 2s to simulate a webhook),
3. an audit line for the `user → eve-demo-agent → github` chain.

## Make it real

`lib/nominee.ts` uses a mock token + a simulated approval. Swap the strategy for
`Auth0(...)` (Token Vault + CIBA) or `OAuth2(...)` and wire `onApprovalRequest` to
your real notifier — the tool code doesn't change.
