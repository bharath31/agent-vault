# nominee examples

## [`github-agent`](./github-agent) — the golden example

An [Eve](https://eve.dev) agent that reviews a pull request and merges it on your
behalf, after your approval. It shows nominee's core value: a long-running agent
whose access **survives the approval pause** because nominee re-resolves it at
action time. Three levels, picked by what you say in the chat:

- **"merge pr"** — the hand-rolled way: grabs access up front, waits, merges —
  the access has expired → **real 403**. The problem.
- **"merge with nominee"** — nominee requests **fresh access at merge time** →
  **real merge**. (Works for everybody; no Auth0.)
- **"merge with nominee and auth0"** — the token is a real GitHub token from
  **Auth0 Token Vault** and approval is a **CIBA push to your phone**.
  (Enterprise Auth0 tenant.)

Everything is real — real GitHub API, real merge of a real PR. Quickstart:

```bash
cd examples/github-agent
nvm use            # Node 24 (Eve requires it)
pnpm install       # workspace install (run once, from the repo root)
pnpm setup         # model credential + a real GitHub token → .env.local
pnpm seed          # opens a PR on a testbed repo on your own GitHub
# then, in two terminals:
pnpm broker        # the merge-access broker (holds the GitHub credential)
pnpm dev           # the agent (interactive chat)
```

See [`github-agent/README.md`](./github-agent/README.md) for the full walkthrough,
including the `pnpm setup:auth0` Token Vault + CIBA path.

## See also

- [`packages/auth0`](../packages/auth0) — the `auth0()` strategy (Token Vault +
  CIBA) used at Level 3, and how to wire it to any provider.
- [`site/agent-worker`](../site/agent-worker) — the deeper, deployed demo running
  live at [nominee.dev/agent](https://nominee.dev/agent) (Cloudflare Durable
  Object, out-of-band approval). Production code, not a starter.
