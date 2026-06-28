# github-agent — a PR review-and-merge agent that survives the pause

An [Eve](https://eve.dev) agent that reviews a pull request and merges it **on
your behalf** — but only after **you** approve. The interesting part is what
happens during the wait: a long-running agent's captured token goes stale, but
nominee re-resolves a **fresh token at merge time**, so the merge just works no
matter how long you took to approve.

Once it's running, try both paths in the chat:

```
› review PR #5 on octocat/hello-world
› merge it without nominee     ← grabs a token, waits, fails with a stale-token 401
› merge it with nominee        ← fresh token at merge time, succeeds
```

## Prerequisites

You need accounts on **Vercel** (Eve's model gateway), **Auth0** (Token Vault +
CIBA), and **GitHub**. The setup script installs and logs you into the CLIs it
needs — you just approve in the browser when prompted.

- [Node 24](https://nodejs.org) (`.nvmrc` pins it — run `nvm use`)
- The setup auto-installs the **Vercel**, **Auth0**, and **GitHub** CLIs if missing.

## Setup (one command)

```bash
nvm use            # Node 24 — Eve requires it
pnpm install       # from the repo root
pnpm setup         # installs CLIs, logs you in, provisions Auth0, writes .env.local
pnpm dev           # start the agent
```

`pnpm setup` walks through everything, pausing only where a human must approve:

1. **CLIs** — installs `vercel`, `auth0`, `gh` if missing, and runs their login
   flows if you're not already authenticated.
2. **Model credential** — runs `eve link` to connect a Vercel project and pull
   **AI Gateway** access (opens a browser to log into Vercel). The agent uses a
   cheap model (`anthropic/claude-haiku-4.5`).
3. **GitHub OAuth App** — prompts you to create one once (it prints the exact
   URL and callback) and paste the client id/secret.
4. **Auth0** — creates the app, the GitHub social connection with **Token
   Vault**, and enables **CIBA**.
5. **Consent** — one browser click to mint your refresh token.
6. Writes everything to **`.env.local`** (which Eve reads and hot-reloads).

Point the agent at a repo you own with an open PR. Everything lands in
`.env.local` (gitignored) — nothing is committed.

### If a step fails

- **`MODEL_CALL_FAILED: AI Gateway received no credentials`** — the model
  credential isn't set. Re-run `eve link` in this folder, or put an
  `AI_GATEWAY_API_KEY` (from <https://vercel.com/dashboard/ai/api-keys>) in
  `.env.local`. Eve only reads `.env.local`, not `.env`.
- **Auth0 connection step warns** — Token Vault is tenant-dependent; the script
  prints the dashboard path to enable it manually, then re-run `pnpm setup`.
- **Auth0 / Vercel / GitHub not logged in** — `pnpm setup` launches each login;
  just complete it in the browser and it continues.

## What nominee removes

The merge **without** nominee — what you write by hand, and it still breaks under
a pause (`agent/tools/merge_pr_naive.ts`):

```ts
const token = await getGitHubToken(user)      // grab once, up front
await waitForApproval(user, 'merge')          // ...long pause...
const res = await fetch(mergeUrl, { headers: { Authorization: `Bearer ${token}` } })
if (res.status === 401) { /* token went stale — now what? refresh? re-auth? */ }
```

The merge **with** nominee (`agent/tools/merge_pr.ts`) — the bookkeeping is gone:

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
- Configuration is real, but it's **one command** (`pnpm setup`). Not zero
  config — just zero config *code*.

Swap `auth0()` for any other nominee strategy and the agent code doesn't change.
