<p align="center">
  <img src="https://raw.githubusercontent.com/bharath31/nominee/main/.github/media/banner-auth0.png?v=2" alt="nominee-auth0" width="100%" />
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/nominee-auth0"><img src="https://img.shields.io/npm/v/nominee-auth0?style=flat-square&colorA=0a0a0f&colorB=f59e0b" alt="npm" /></a>
  <a href="https://www.npmjs.com/package/nominee"><img src="https://img.shields.io/npm/v/nominee?style=flat-square&colorA=0a0a0f&colorB=7c3aed&label=requires%20nominee" alt="nominee peer" /></a>
  <a href="https://github.com/bharath31/nominee/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/nominee-auth0?style=flat-square&colorA=0a0a0f&colorB=555" alt="license" /></a>
</p>

<p align="center">
  <strong>Auth0 strategy for nominee.</strong><br />
  Token Vault for federated tokens · CIBA for push-to-phone approvals.
</p>

> **Optional.** The nominee core has zero dependencies and works without Auth0. Use this if you want Auth0 to manage token storage and push approvals for you.

---

## Installation

```bash
npm i nominee nominee-auth0
```

---

## What It Does

```mermaid
flowchart TB
    subgraph "nominee-auth0"
        direction TB
        TV["Token Vault\ngetToken()"] 
        CIBA["CIBA\nrequestApproval()"]
    end

    Agent["Agent calls\nnominee.token()"] --> TV
    TV -->|"token exchange\ngrant (federated)"| Auth0["Auth0 Tenant"]
    Auth0 -->|fresh token| TV
    TV --> Agent

    Agent2["Agent calls\nnominee.approve()"] --> CIBA
    CIBA -->|"POST /bc-authorize"| Auth0
    Auth0 -->|push notification| Phone["User's phone 📱"]
    Phone -->|approve / deny| Auth0
    Auth0 -->|poll result| CIBA
    CIBA --> Agent2
```

| Feature | What it does |
|---|---|
| **Token Vault** | Fetches fresh federated connection tokens (GitHub, Google, Slack…) from Auth0. No token storage in your DB. |
| **CIBA** | Pushes an approval request to the user's device and polls until resolved. Real phone notifications, not a polling UI. |

---

## Quickstart

```ts
import { Nominee } from 'nominee'
import { Auth0 } from 'nominee-auth0'

const nominee = new Nominee({
  strategy: Auth0({
    domain: process.env.AUTH0_DOMAIN!,          // e.g. 'my-tenant.us.auth0.com'
    clientId: process.env.AUTH0_CLIENT_ID!,
    clientSecret: process.env.AUTH0_CLIENT_SECRET!,
    subjectToken: ({ user }) => sessionStore.getRefreshToken(user),
  }),
})

// Fetches a fresh GitHub token from Auth0 Token Vault
const token = await nominee.token({
  user: 'auth0|user_123',
  connection: 'github',
})
```

---

## CIBA — Push Approvals

Require human approval before an agent action, delivered as a push notification to the user's phone:

```ts
const nominee = new Nominee({
  strategy: Auth0({
    domain: process.env.AUTH0_DOMAIN!,
    clientId: process.env.AUTH0_CLIENT_ID!,
    clientSecret: process.env.AUTH0_CLIENT_SECRET!,
    subjectToken: ({ user }) => sessionStore.getRefreshToken(user),

    // Enable CIBA
    ciba: {
      bindingMessage: (req) => `Approve "${req.action}"?`,
    },
  }),
})

// Blocks until the user approves on their phone
await nominee.approve({
  user: 'auth0|user_123',
  action: 'repo.delete',
  detail: 'Delete repository: alice/old-project',
})
```

---

## With Adapters

Drop-in replacement — just swap the strategy:

```ts
import { nomineeTool } from 'nominee-ai'   // or nominee-eve
import { z } from 'zod'

const starRepo = nomineeTool({
  nominee,                // Auth0 strategy under the hood
  user: 'auth0|user_123',
  connection: 'github',
  approval: true,
  action: 'repo.star',
  description: 'Star a GitHub repository',
  inputSchema: z.object({ repo: z.string() }),
  execute: async ({ repo }, ctx) => {
    // ctx.token is a fresh token from Auth0 Token Vault
    await fetch(`https://api.github.com/user/starred/${repo}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${ctx.token}` },
    })
    return `Starred ${repo}`
  },
})
```

---

## Auth0 Setup (the honest version)

nominee removes the *runtime* token pain — one `nominee.token()` call, always fresh.
It does **not** remove Auth0/provider *setup*: that's a one-time job with sharp edges.
Here's what actually works, learned the hard way wiring the live GitHub demo:

1. **Enable Token Vault on the connection — via Connected Accounts.** Token Vault is now
   driven by **Connected Accounts**; set the top-level `connected_accounts.active` on the
   connection (the older `options.federated_connections_access_tokens` is deprecated):
   ```bash
   auth0 api patch "connections/<CONNECTION_ID>" --data '{"connected_accounts":{"active":true}}'
   ```
2. **GitHub: use a GitHub _App_ with expiring tokens — not a classic OAuth App.** Classic
   OAuth Apps never issue refresh tokens, so Token Vault has nothing to vault (you'll get
   `federated_connection_refresh_token_not_found`). Create a **GitHub App**, turn on
   **"Expire user authorization tokens"**, set the callback to
   `https://<tenant>/login/callback`, and point the connection at the App's client id/secret.
3. **Grant the exact permission the action needs — App vs repo scope matters.** GitHub App
   user tokens carry **account** permissions from user authorization, but **repository**
   permissions (e.g. `metadata=read`) require the App to be **installed** on the repo.
   Account-only actions (publish a gist, edit profile) need no installation; repo actions do.
   A `403 "Resource not accessible by integration"` means a missing permission — read the
   `x-accepted-github-permissions` response header to see exactly which.
4. **Re-vault after changing permissions.** Connected Accounts caches the grant. After
   changing what the user approved, delete the stale connected account
   (`DELETE /me/v1/connected-accounts/{id}` via the user's My Account token) and reconnect so
   the fresh consent is vaulted.
5. **CIBA** for push approvals: enable it in the tenant, then set `ciba` in the strategy.

Once wired, the runtime is just `await nominee.token({ user, connection })` — and you can
swap this whole strategy for `tokens()` or `OAuth2()` without touching your agent code.
See the [Auth0 documentation](https://auth0.com/docs) for the rest of tenant configuration.

---

## Auth0 Strategy Options

```ts
Auth0({
  domain: string           // Auth0 tenant domain
  clientId: string         // M2M application client ID
  clientSecret: string     // M2M application client secret
  subjectToken: (params: GetTokenParams) => string | Promise<string>
  subjectTokenType?: 'refresh_token' | 'access_token'
  fetch?: typeof fetch     // optional custom fetch (defaults to global)

  ciba?: {
    loginHint?: (user: string) => string | Promise<string>
    bindingMessage?: (req: ApprovalRequest) => string  // message shown to user
    pollIntervalMs?: number    // default: from Auth0 response interval
    scope?: string             // default: 'openid'
    audience?: string
  }
})
```

---

<p align="center">
  <a href="https://github.com/bharath31/nominee">GitHub</a> ·
  <a href="https://www.npmjs.com/package/nominee">nominee core</a> ·
  MIT License
</p>
