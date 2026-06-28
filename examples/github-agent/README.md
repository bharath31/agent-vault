# github-agent — a PR review-and-merge agent that survives the pause

An [Eve](https://eve.dev) agent that reviews a real pull request and merges it
**on your behalf**. The point it proves: a long-running agent's token goes stale
during the wait for approval — but nominee re-resolves a **fresh token at merge
time**, so the merge just works no matter how long the pause was.

Everything here is **real** — real GitHub API, real merge of a real PR. The
*only* thing simulated is **time**: the approval pause is compressed from the
minutes/hours a real agent waits down to a few seconds, so you can watch a
captured token go stale in one sitting.

## Three levels

Once it's running, you drive the demo by what you say in the chat:

| Say | Tool | What it shows |
| --- | --- | --- |
| **"merge without nominee"** | `merge_pr_naive` | Hand-rolled: grab a token, wait, merge — the captured token is **stale → 401**. The problem. |
| **"merge with nominee"** | `merge_pr` | nominee re-resolves a **fresh token at merge time**; you approve in the chat → **real merge**. |
| **"merge with nominee and auth0"** | `merge_pr_auth0` | Same, but the token is from **Auth0 Token Vault** and approval is a **CIBA push to your phone**. |

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
pnpm seed          # open a fresh PR in the testbed repo to act on
pnpm dev           # start the agent (interactive chat in your terminal)
```

Then in the chat (use the PR `pnpm seed` printed):

```
› review PR #2 on bharath31/nominee-agent-testbed
› merge it without nominee     ← fails: stale token (time-compressed)
› merge it with nominee        ← approve in chat → real merge
```

Merging closes the PR, so run `pnpm seed` again for another round. Point it at
your own repo by setting `TESTBED_REPO=owner/repo` before `pnpm seed`.

### Level 3 — Auth0 Token Vault + CIBA

```bash
pnpm setup:auth0   # provisions the Auth0 app, GitHub connection + Token Vault, CIBA, one consent click
pnpm dev
```

Then: `merge it with nominee and auth0` — the token comes from Token Vault and
the approval is pushed to your phone. If Auth0 isn't configured, the tool tells
you to run `pnpm setup:auth0`.

## What nominee removes

The merge **without** nominee — what you write by hand, and it still breaks under
a pause (`agent/tools/merge_pr_naive.ts`):

```ts
const token = process.env.GITHUB_TOKEN        // grab once, up front
await waitForApproval()                        // ...long pause (time-compressed)...
const res = await fetch(mergeUrl, { headers: { Authorization: `Bearer ${token}` } })
if (res.status === 401) { /* token went stale — now what? refresh? re-auth? */ }
```

The merge **with** nominee (`agent/tools/merge_pr.ts`) — the bookkeeping is gone:

```ts
connection: 'github',     // nominee fetches a fresh token at call time
needsApproval: always(),  // human-in-the-loop, right in the chat
```

And Level 3 is the *same tool shape* — only the nominee instance changes
(`auth0()` instead of the gh-token strategy), and approval becomes a CIBA phone
push. You never write token-refresh or approval plumbing at any level.
