# github-agent — a PR review-and-merge agent that survives the pause

An [Eve](https://eve.dev) agent that reviews a pull request and merges it **on
your behalf** — but only after **you** approve. The interesting part is what
happens during the wait: a long-running agent's captured token goes stale, but
nominee re-resolves a **fresh token at merge time**, so the merge just works no
matter how long you took to approve.

## Run it (mock mode — zero setup)

```bash
nvm use            # Node 24 (Eve requires it)
pnpm install       # from the repo root
pnpm dev           # opens the Eve chat in your terminal
```

In the chat, try the two paths:

```
› review PR #5 on octocat/hello-world
› merge it without nominee     ← grabs a token, waits, fails with a stale-token 401
› merge it with nominee        ← fresh token at merge time, succeeds
```

In mock mode the GitHub calls are **simulated** (no real token, no real merge) so
you can feel the contrast instantly. The stale-token failure is a *real* expiry —
the token genuinely passes its `expiresAt` during the pause; we just shrink the
TTL to a few seconds so it's visible in a demo.

## Make it real (one command)

```bash
pnpm setup         # provisions Auth0 + AI Gateway, one consent click, writes .env
pnpm dev
```

Now the approval is a real **CIBA push to your phone**, the token comes from real
**Auth0 Token Vault**, and the merge **actually closes a PR**. Point it at a repo
you own with an open PR. `setup` needs the [Auth0 CLI](https://auth0.github.io/auth0-cli/)
and [`gh`](https://cli.github.com/); it creates a one-time GitHub OAuth App
(prompted) and, for the model, an `AI_GATEWAY_API_KEY` (or run `eve link`).

## What nominee removes

Here is the merge **without** nominee — what you write by hand, and it still
breaks under a pause (`agent/tools/merge_pr_naive.ts`):

```ts
const token = await getGitHubToken(user)      // grab once, up front
await waitForApproval(user, 'merge')          // ...long pause...
const res = await fetch(mergeUrl, { headers: { Authorization: `Bearer ${token}` } })
if (res.status === 401) { /* token went stale — now what? refresh? re-auth? */ }
```

And **with** nominee (`agent/tools/merge_pr.ts`) — the bookkeeping is gone:

```ts
connection: 'github',   // nominee fetches a fresh token at call time
approval: true,         // human-in-the-loop, provider-portable
```

That's the whole difference. You declare two keys; nominee owns token freshness
and approval.

## The claim, precisely

- **3 lines** wire nominee once (`lib/nominee.ts`):
  ```ts
  export const nominee = new Nominee({ strategy: auth0() })
  ```
- **2 keys** per sensitive tool — `connection` and `approval` — and you never
  write token-refresh or approval code again.
- Configuration is real, but it's **one command, once** (`pnpm setup`). Not zero
  config — just zero config *code*.

Swap `auth0()` for any other nominee strategy and the agent code doesn't change.
