# github-agent — a PR review-and-merge agent that survives the pause

An [Eve](https://eve.dev) agent that reviews a real pull request and merges it
**on your behalf**. The point it proves: a long-running agent's token goes stale
during the wait for approval — but nominee re-resolves a **fresh token at merge
time**, so the merge just works no matter how long the pause was.

Everything here is **real** — including the token expiry. No mocking.

## The setup: a merge-access broker

Merging a protected branch is privileged, so this demo gates it the way real orgs
do: behind a **merge-access broker** (`service/broker.ts`) that hands out
**just-in-time, short-lived access tokens**. The broker is the only thing holding
the GitHub credential; the agent only ever gets a token that's valid for a few
seconds — least-privilege, just-in-time access. That short lifetime is genuine:
the broker enforces it and returns a real **HTTP 403** when a token has lapsed.
Nothing is simulated; we just don't have to wait an hour to see a token expire,
because it's *our* token with a deliberately short TTL.

That's the whole point made concrete: a long-running agent that grabs access up
front finds it expired by the time a human approves.

## Three levels

Once it's running, you drive the demo by what you say in the chat:

| Say | Tool | What it shows |
| --- | --- | --- |
| **"merge pr"** | `merge_pr` | The hand-rolled way: request access, wait for approval, merge — but the access expired during the wait → **real 403 from the broker**. The problem most people hit. |
| **"merge with nominee"** | `merge_pr_with_nominee` | nominee requests **fresh access at merge time**; you approve in the chat → **real merge**. |
| **"merge with nominee and auth0"** | `merge_pr_with_nominee_auth0` | The token is a real GitHub token from **Auth0 Token Vault** and approval is a **CIBA push to your phone**. |

## Prerequisites

- [Node 24](https://nodejs.org) (`nvm use` — `.nvmrc` pins it).
- A **[Vercel](https://vercel.com) account** — Eve routes the model through the
  Vercel AI Gateway. `pnpm setup` runs `eve link` to connect it.
- A **GitHub account** — `pnpm setup` uses the `gh` CLI for a real token.
- **Level 3 only:** an **[Auth0](https://auth0.com) account** with **Token Vault
  + CIBA** (these are advanced features — not on free/basic tenants), and the
  **[Auth0 Guardian](https://auth0.com/docs/secure/multi-factor-authentication/auth0-guardian)
  app** on your phone (it receives the approval push). Enable the **push**
  factor in your tenant: Security → Multi-factor Auth → Push Notifications.

The setup script installs the `vercel`, `gh` (and for Level 3, `auth0`) CLIs if
they're missing and runs their logins.

## Run it

```bash
git clone https://github.com/bharath31/nominee && cd nominee
pnpm install                   # workspace install, from the repo root (needs pnpm)
cd examples/github-agent       # all the commands below live here
nvm use                        # Node 24 — Eve requires it (.nvmrc pins it)
pnpm setup                     # installs CLIs, eve link (model), writes a GitHub token → .env.local
pnpm seed                      # opens a PR on a testbed repo on YOUR GitHub
```

Then run the broker and the agent in **two terminals** (both from
`examples/github-agent`):

```bash
pnpm broker        # terminal 1 — the merge-access broker (holds the GitHub credential)
pnpm dev           # terminal 2 — the agent (interactive chat)
```

> Need pnpm? `npm i -g pnpm`. Need Node 24? `nvm install 24`. The agent **and**
> the broker must both run — if the chat says "broker is not reachable," start
> `pnpm broker`.

`pnpm seed` creates `‹your-username›/nominee-agent-testbed` (public) the first
time and opens a fresh PR, printing the exact `review PR #N on …` line to paste.

### Walk the demo (Levels 1 & 2)

Paste these into the agent chat one at a time. Use the PR number `pnpm seed`
printed (shown as `#1` below):

```
› review PR #1 on ‹your-username›/nominee-agent-testbed
    → reads the PR: title, diff size, merge state

› merge pr
    → ✗ fails: the access it grabbed expired during the wait (a real 403 from
      the broker). The PR stays open. This is the problem.

› merge with nominee
    → pauses for your approval in the chat — approve it
    → ✓ real merge: nominee fetched fresh access at merge time. PR is now merged.
```

Watch the **broker** terminal as you go — you'll see it `→ issue` a token, then
`✗ 403 reject` the stale one (Level 1), then `✓ merge` with a fresh one (Level 2).

Merging closes the PR, so **seed another one for the next round**:

```
pnpm seed                      # opens a fresh PR; note the new number
```

Then try the same arc again, or jump to Level 3 below. To act on a repo you
already own instead of the testbed, set `TESTBED_REPO=owner/repo` before
`pnpm seed`.

### Walk Level 3 (Auth0 Token Vault + CIBA)

Once you've run `pnpm setup:auth0` (see below), seed a fresh PR and try:

```
pnpm seed
```
```
› review PR #2 on ‹your-username›/nominee-agent-testbed
› merge with nominee and auth0
    → nominee pulls a fresh GitHub token from Auth0 Token Vault and sends a CIBA
      push to your phone
    → approve on your phone (Auth0 Guardian)
    → ✓ real merge — same agent, same code shape, now with a vaulted token + a
      phone approval instead of an in-chat one
```

If Auth0 isn't set up yet, the tool replies telling you to run `pnpm setup:auth0`.

### Level 3 — Auth0 Token Vault + CIBA

```bash
pnpm setup:auth0   # provisions the Auth0 app, reuses/creates the Token Vault github
                   # connection, sets the CIBA + federated grants, one consent click
pnpm dev
```

**MFA enrollment for the CIBA push.** The approval is a push to the **Auth0
Guardian** app, so the user must have a Guardian device enrolled. If your tenant's
policy forces MFA during the Token Vault consent, you'll be shown a QR to scan
inline. If it doesn't (tenant-dependent), enroll one under your user's MFA in the
Auth0 dashboard first, and make sure the **push** factor is enabled (Security →
Multi-factor Auth → Push Notifications). `setup:auth0` ends with a check; if it
says the push can't be delivered, that's the enrollment.

Then: `merge with nominee and auth0` — nominee pulls a fresh GitHub token from
Token Vault and pushes the approval to your phone. Approve it, and the merge runs.
If Auth0 isn't configured, the tool tells you to run `pnpm setup:auth0`.

> **If the merge returns `403 Resource not accessible by integration`:** the
> GitHub App or OAuth app behind your Auth0 github connection can't merge on the
> target repo. (`setup:auth0` warns about this up front — see the verify step.)
> - **GitHub App:** grant **Pull requests: Read & write** + **Contents: Read &
>   write**, **Install the app on the repo** you're merging (App → *Install App*
>   tab — `total_count:0` installations means it isn't installed), then
>   **disconnect the GitHub connected account** in Auth0 and re-run `setup:auth0`
>   so the new permission is re-vaulted.
> - **OAuth app:** request the `repo` scope (the example vaults `public_repo`, so
>   only **public** repos merge out of the box; a private `TESTBED_REPO` needs
>   `repo`).
>
> Token Vault can only hand the agent what the underlying app is allowed to do —
> that's the point.

## What nominee removes

The plain merge — what you write by hand, and it still breaks under a pause
(`agent/tools/merge_pr.ts`):

```ts
const access = await requestAccess()           // grab access once, up front
await waitForApproval()                         // ...long pause...
const res = await brokerMerge(access.token, pr) // access expired → broker 403
// now what? request again? thread it through? this is the bookkeeping you write.
```

The merge **with** nominee (`agent/tools/merge_pr_with_nominee.ts`) — the
bookkeeping is gone:

```ts
connection: 'github',     // nominee requests fresh access at call time
needsApproval: always(),  // human-in-the-loop, right in the chat
```

And Level 3 is the *same tool shape* — only the nominee instance changes
(`auth0()` instead of the gh-token strategy), and approval becomes a CIBA phone
push. You never write token-refresh or approval plumbing at any level.
