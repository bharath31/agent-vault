# auth0-github-agent — a durable agent that pauses, emails you, and survives the wait

> **This is the deployed `nominee.dev/agent` worker**, kept in `site/` so it ships
> with the microsite. It is the production demo, not a teaching example — for a
> minimal, runnable walkthrough see [`examples/github-agent`](../../examples/github-agent).

The honest, deep demo. **You** connect your GitHub through Auth0 (real OAuth
consent). Then you start a **multi-step agent session** that runs as a
**Durable Object**:

1. The agent reads your real GitHub (profile + recent repos) with a fresh
   nominee token, and drafts a gist summarizing the session.
2. It hits the sensitive action (publish the gist) and **pauses** — it emails
   you an approve/deny link and **hibernates**. No compute runs while it waits.
3. You approve **out of band**, from your phone or inbox, minutes or hours later.
4. The Durable Object wakes. nominee fetches the GitHub token **at that moment**
   from Auth0 Token Vault — never a token captured at session start — and the
   agent publishes the gist on your account.
5. The console shows the full live timeline: the pause clock, the resume after
   the gap, the call-time token, and the audit chain.

This is the value prop you can't fake: a long-running agent whose **access
outlives the pause** because nominee re-resolves the token at action time, plus
**human approval that arrives out of band** (email/phone), not a blocking
in-browser button.

## Why a Durable Object

A real agent session doesn't finish in one request — it waits for a human. The
DO holds the session state (and the user's refresh token) durably across the
pause. The one rule: the strategy reads the refresh token from durable storage
at call time, so `nominee.token()` works whether the wake is 30s or 3h later.
See `examples/cloudflare-durable-agent` for the minimal version of this pattern.

## Setup (one-time)

1. **GitHub App** (not a classic OAuth App — only Apps issue refresh tokens) with
   "Expire user authorization tokens" on, account permission `gists: write`.
2. **Auth0 → GitHub social connection** using that App's id/secret, with
   **Token Vault / Connected Accounts enabled** (`connected_accounts.active`).
3. **Auth0 → Regular Web App**: callback `https://nominee.dev/agent/callback`,
   logout `https://nominee.dev/agent`, grants Authorization Code + Refresh Token.
4. **Resend**: a verified sending domain; the `FROM` var in `wrangler.toml` uses
   it. (See `packages/auth0/README.md` for the Token Vault gotchas in detail.)

## Secrets

```bash
wrangler secret put AUTH0_DOMAIN
wrangler secret put AUTH0_CLIENT_ID
wrangler secret put AUTH0_CLIENT_SECRET
wrangler secret put SESSION_SECRET   # openssl rand -hex 32
wrangler secret put RESEND_API_KEY   # for the out-of-band approval email
wrangler deploy
```

Live at https://nominee.dev/agent. Swap `Auth0(...)` for `OAuth2(...)` or a
function and the same agent code works with any provider — Token Vault is just
the managed source here.

## Routes

| Route | Who calls it | What it does |
|---|---|---|
| `POST /agent/session/start` | the logged-in console | creates the DO, runs steps 1–2, emails you, hibernates |
| `GET /agent/session/:id` | the console (polling) | live session state for the timeline |
| `GET /agent/approve?id=&k=` | **the email link** | wakes the DO, fetches a fresh token, publishes |
| `GET /agent/deny?id=&k=` | the email link | stays paused, no action |
| `GET /agent/demo/token`, `/agent/demo/api` | the homepage race | short-TTL token + guarded API for the in-browser nominee race |
