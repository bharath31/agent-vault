# nominee examples

Runnable examples, smallest to most complete.

| Example | What it shows | Provider needed |
| --- | --- | --- |
| [`standalone-node`](./standalone-node) | Core API end-to-end — token caching/refresh, `approve()`/`resolveApproval()`, audit stream | None (mock strategy) |
| [`vercel-ai-github`](./vercel-ai-github) | A real Vercel AI SDK agent: fresh token injected into a tool, approval gating a sensitive action | OpenAI API key |
| [`eve-agent`](./eve-agent) | A Vercel Eve agent whose tool draws its token + approval from nominee | None to read; Eve to run |

Each example uses the workspace packages (`nominee`, `nominee-ai`, `nominee-eve`) via `workspace:*`, so from the repo root:

```bash
pnpm install
pnpm --filter <example-name> dev
```

The default strategy in these demos is a mock/function strategy — no signup. Swap it for `Auth0(...)` (see the [`nominee-auth0`](../packages/auth0) README) to get managed Token Vault tokens and CIBA phone approvals with no other code change.
