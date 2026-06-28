# github-agent — a PR review-and-merge agent that survives the pause

An [Eve](https://eve.dev) agent that reviews a real pull request and merges it
**on your behalf**. The point it proves: a long-running agent's token goes stale
during the wait for approval — but nominee re-resolves a **fresh token at merge
time**, so the merge just works no matter how long the pause was.

Everything here is **real** — real GitHub API, real merge of a real PR — with
**one deliberate simulation**, called out below.

> ### ⚠️ We simulate the token expiry
> A real GitHub token lives ~1 hour. We can't make a demo wait an hour for it to
> actually expire, so on the plain **"merge pr"** path we **compress time**: the
> approval pause is a few seconds and the captured token is *treated* as expired
> after `DEMO_TTL_MS`. The resulting `401` is **thrown by our own code**
> (`lib/github.ts`), **not** returned by GitHub — the real token is still valid.
> It stands in for the failure that would genuinely happen an hour into a paused
> agent session. The **merge with nominee** path performs a real GitHub merge.

## Three levels

Once it's running, you drive the demo by what you say in the chat:

| Say | Tool | What it shows |
| --- | --- | --- |
| **"merge pr"** | `merge_pr` | The plain, hand-rolled merge: grab a token, wait, merge — the captured token is **stale → 401**. The problem most people hit. |
| **"merge with nominee"** | `merge_pr_with_nominee` | nominee re-resolves a **fresh token at merge time**; you approve in the chat → **real merge**. |
| **"merge with nominee and auth0"** | `merge_pr_with_nominee_auth0` | Same, but the token is from **Auth0 Token Vault** and approval is a **CIBA push to your phone**. |

## Prerequisites

- [Node 24](https://nodejs.org) (`nvm use` — `.nvmrc` pins it).
- A **[Vercel](https://vercel.com) account** — Eve routes the model through the
  Vercel AI Gateway. `pnpm setup` runs `eve link` to connect it.
- A **GitHub account** — `pnpm setup` uses the `gh` CLI for a real token.
- **Level 3 only:** an **[Auth0](https://auth0.com) account** with **Token Vault
  + CIBA** (these are advanced features — not on free/basic tenants).

The setup script installs the `vercel`, `gh` (and for Level 3, `auth0`) CLIs if
they're missing and runs their logins.

## Run it

```bash
nvm use            # Node 24
pnpm install       # from the repo root
pnpm setup         # installs CLIs, eve link (model), writes a GitHub token → .env.local
pnpm seed          # creates a testbed repo on YOUR GitHub + opens a PR to act on
pnpm dev           # start the agent (interactive chat in your terminal)
```

`pnpm seed` creates `‹your-username›/nominee-agent-testbed` (public) the first
time and opens a fresh PR, printing the exact line to paste. Then in the chat:

```
› review PR #1 on ‹your-username›/nominee-agent-testbed
› merge pr                     ← fails: stale token (time-compressed)
› merge with nominee           ← approve in chat → real merge
```

Merging closes the PR, so run `pnpm seed` again for another round. To use a repo
you already own instead, set `TESTBED_REPO=owner/repo` before `pnpm seed`.

### Level 3 — Auth0 Token Vault + CIBA

```bash
pnpm setup:auth0   # provisions the Auth0 app, GitHub connection + Token Vault, CIBA, one consent click
pnpm dev
```

Then: `merge with nominee and auth0` — the token comes from Token Vault and
the approval is pushed to your phone. If Auth0 isn't configured, the tool tells
you to run `pnpm setup:auth0`.

## What nominee removes

The plain merge — what you write by hand, and it still breaks under a pause
(`agent/tools/merge_pr.ts`):

```ts
const token = process.env.GITHUB_TOKEN        // grab once, up front
await waitForApproval()                        // ...long pause (time-compressed)...
const res = await fetch(mergeUrl, { headers: { Authorization: `Bearer ${token}` } })
if (res.status === 401) { /* token went stale — now what? refresh? re-auth? */ }
```

The merge **with** nominee (`agent/tools/merge_pr_with_nominee.ts`) — the
bookkeeping is gone:

```ts
connection: 'github',     // nominee fetches a fresh token at call time
needsApproval: always(),  // human-in-the-loop, right in the chat
```

And Level 3 is the *same tool shape* — only the nominee instance changes
(`auth0()` instead of the gh-token strategy), and approval becomes a CIBA phone
push. You never write token-refresh or approval plumbing at any level.
