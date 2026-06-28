# nominee examples

## [`github-agent`](./github-agent) — the golden example

An [Eve](https://eve.dev) agent that reviews a pull request and merges it on your
behalf, after your approval. It shows nominee's core value in one demo: a
long-running agent whose token **survives the approval pause** because nominee
re-resolves it at action time. It ships two paths side by side — merge *without*
nominee (captured token goes stale → 401) and merge *with* nominee (fresh token
at merge time → success).

```bash
nvm use            # Node 24
pnpm install       # from the repo root
pnpm dev           # try it in mock mode — zero setup
```

Then `pnpm setup` flips the *same code* to real Auth0 Token Vault + CIBA with one
command. See [`github-agent/README.md`](./github-agent/README.md) for the full
walkthrough.

## See also

- [`packages/auth0`](../packages/auth0) — the `auth0()` strategy (Token Vault +
  CIBA) used above, and how to wire it to any provider.
- [`site/agent-worker`](../site/agent-worker) — the deeper, deployed demo running
  live at [nominee.dev/agent](https://nominee.dev/agent) (Cloudflare Durable
  Object, out-of-band email approval). Production code, not a starter.
