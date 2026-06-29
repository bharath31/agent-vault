# github-agent — a PR review-and-merge agent that survives the pause

An [Eve](https://eve.dev) agent that reviews a real pull request and merges it
**on your behalf**. The point it proves: a long-running agent's access goes stale
during the wait for approval — but nominee re-resolves **fresh access at merge
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
front finds it expired by the time a human approves. The short-TTL broker isn't a
strawman — it's the fastest honest way to reproduce, in seconds, the exact
staleness you hit on any real provider after a long pause. For the underlying
mechanism in plain code (expiry **+ refresh-token rotation + concurrency**, with
a runnable `7/8 fail → 8/8` proof), see
[`examples/token-refresh-correctness`](../token-refresh-correctness).

## Three levels

You drive the demo by what you say in the chat:

| Say | Tool | What it shows |
| --- | --- | --- |
| **"merge pr"** | `merge_pr` | The hand-rolled way: request access, wait for approval, merge — but the access expired during the wait → **real 403 from the broker**. The problem most people hit. |
| **"merge with nominee"** | `merge_pr_with_nominee` | nominee requests **fresh access at merge time**; you approve in the chat → **real merge**. (Works for everybody.) |
| **"merge with nominee and auth0"** | `merge_pr_with_nominee_auth0` | The token is a real GitHub token from **Auth0 Token Vault** and approval is a **CIBA push to your phone**. (Enterprise Auth0.) |

## Prerequisites

- [Node 24](https://nodejs.org) (`nvm use` — `.nvmrc` pins it) and **pnpm**
  (`npm i -g pnpm`).
- A **[Vercel](https://vercel.com) account** — Eve routes the model through the
  Vercel AI Gateway. `pnpm setup` runs `eve link` to connect it.
- A **GitHub account** — `pnpm setup` uses the `gh` CLI for a real token.
- **Level 3 only:** an **[Auth0](https://auth0.com) account** with **Token Vault
  + CIBA** (advanced features — not on free/trial tenants), and the
  **[Auth0 Guardian](https://auth0.com/docs/secure/multi-factor-authentication/auth0-guardian)**
  app on your phone (it receives the approval push).

The setup script installs the `vercel`, `gh` (and for Level 3, `auth0`) CLIs if
they're missing and runs their logins.

## 1. Set up

```bash
git clone https://github.com/bharath31/nominee && cd nominee
pnpm install                   # workspace install, from the repo root
cd examples/github-agent       # every command below runs from here
nvm use                        # Node 24 — Eve requires it
pnpm setup                     # installs CLIs, eve link (model), writes a GitHub token → .env.local
pnpm seed                      # opens a PR on a testbed repo on YOUR GitHub; prints its number
```

`pnpm seed` creates `‹your-username›/nominee-agent-testbed` (public) the first
time and opens a fresh PR, printing the exact `review PR #N on …` line to paste.
To act on a repo you already own instead, set `TESTBED_REPO=owner/repo` first.

## 2. Run it (two terminals)

```bash
pnpm broker        # terminal 1 — the merge-access broker (holds the GitHub credential)
pnpm dev           # terminal 2 — the agent (interactive chat)
```

> The agent **and** the broker must both be running. If the chat says "broker is
> not reachable," start `pnpm broker`.

## 3. Test Levels 1 & 2 (no Auth0)

Paste these into the agent chat one at a time, using the PR number `pnpm seed`
printed (shown as `#1`):

```
› review PR #1 on ‹your-username›/nominee-agent-testbed
    → reads the PR: title, diff size, merge state

› merge pr
    → ✗ fails: the access it grabbed expired during the wait (a real 403 from the
      broker). The PR stays open. This is the problem.

› merge with nominee
    → pauses for your approval in the chat — approve it
    → ✓ real merge: nominee fetched fresh access at merge time. PR is now merged.
```

Watch the **broker** terminal as you go: it logs `→ issue` a token, `✗ 403 reject`
the stale one (Level 1), then `✓ merge` with a fresh one (Level 2).

Merging closes the PR, so **seed another for the next round**:

```bash
pnpm seed          # opens a fresh PR; note the new number
```

## 4. Test Level 3 (Auth0 Token Vault + CIBA)

The same agent, but the GitHub token comes from **Auth0 Token Vault** and approval
is a **CIBA push to your phone**. One-time setup (enterprise Auth0 tenant):

```bash
pnpm setup:auth0   # creates the Auth0 app, reuses/creates the Token Vault github
                   # connection, sets the CIBA + federated grants, one consent click.
                   # Ends by verifying the vaulted token can actually merge.
```

Then seed a fresh PR and, in the chat:

```bash
pnpm seed          # opens a fresh PR; note the number
```
```
› review PR #N on ‹your-username›/nominee-agent-testbed
› merge with nominee and auth0
    → nominee pulls a fresh GitHub token from Token Vault and sends a CIBA push to
      your phone
    → approve on your phone (Auth0 Guardian)
    → ✓ real merge — same code shape as Level 2, now with a vaulted token and a
      phone approval instead of an in-chat one
```

If Auth0 isn't configured, the tool tells you to run `pnpm setup:auth0`.

**MFA enrollment for the CIBA push.** The push goes to the Auth0 Guardian app, so
your user must have a Guardian device enrolled. If your tenant's policy forces MFA
during the Token Vault consent, you'll get a QR to scan inline. If not
(tenant-dependent), enroll one under your user's MFA in the Auth0 dashboard and
enable the **push** factor (Security → Multi-factor Auth → Push Notifications).
`setup:auth0` ends with a check that flags this.

> **If the merge returns `403 Resource not accessible by integration`:** the
> GitHub App or OAuth app behind your Auth0 github connection can't merge on the
> target repo (`setup:auth0`'s verify step warns about this up front):
> - **GitHub App:** grant **Pull requests** + **Contents** = Read & write,
>   **Install the app on the repo** (App → *Install App* tab — `total_count:0`
>   installations means it isn't installed), then **disconnect the GitHub
>   connected account** in Auth0 and re-run `setup:auth0` to re-vault.
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

## When you don't need nominee

nominee isn't the only way to fix the stale-token problem, and it isn't always the
right one. If your framework already brokers fresh third-party access for you (Eve,
Vercel Connect) or you're on a managed token layer (Auth0 Token Vault on its own,
Nango), use that — reach for nominee when you want this behaviour **framework-neutral
and without a SaaS**: bring your own store, keep the same agent code across Eve, the
Vercel AI SDK, or standalone, and swap the vault underneath without rewriting tools.
