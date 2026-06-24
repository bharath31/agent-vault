# auth0-github-agent — the real delegated-access demo

The honest demo: **you** connect your GitHub through Auth0 (real OAuth consent),
the agent proposes an action on **your** account, **you** approve, and nominee
fetches a *fresh* token for you from **Auth0 Token Vault** to do it.

Flow: connect GitHub → vaulted by Auth0 → agent proposes `github.star` → your
approval → `nominee.token({ connection: 'github' })` pulls a fresh token from
Token Vault → the repo is really starred on your account → audit.

## Setup (one-time)
1. **GitHub OAuth App** → callback `https://YOUR_AUTH0_DOMAIN/login/callback`.
2. **Auth0 → GitHub social connection** with that app's id/secret, scopes
   `read:user public_repo`, **Token Vault enabled**.
3. **Auth0 → Regular Web App**: callback `https://nominee.dev/agent/callback`,
   logout `https://nominee.dev/agent`, grants Authorization Code + Refresh Token.

## Secrets
```bash
wrangler secret put AUTH0_DOMAIN
wrangler secret put AUTH0_CLIENT_ID
wrangler secret put AUTH0_CLIENT_SECRET
wrangler secret put SESSION_SECRET   # openssl rand -hex 32
wrangler deploy
```

Live at https://nominee.dev/agent. Swap the strategy and the same code works with
any nominee provider — Token Vault is the managed source here.
