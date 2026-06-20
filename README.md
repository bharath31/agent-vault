# nominee

[![npm](https://img.shields.io/npm/v/nominee?label=nominee)](https://www.npmjs.com/package/nominee)
[![npm](https://img.shields.io/npm/v/nominee-ai?label=nominee-ai)](https://www.npmjs.com/package/nominee-ai)
[![npm](https://img.shields.io/npm/v/nominee-eve?label=nominee-eve)](https://www.npmjs.com/package/nominee-eve)
[![npm](https://img.shields.io/npm/v/nominee-auth0?label=nominee-auth0)](https://www.npmjs.com/package/nominee-auth0)
[![license](https://img.shields.io/npm/l/nominee)](LICENSE)

**Identity and token delegation for AI agents.**

You authorized the agent at 9am. By 3pm, the GitHub token has expired, but the agent is still running in a Durable Object, or pausing for human input, or looping over a massive codebase. Suddenly: silent `401 Unauthorized` errors.

An agent acting on behalf of a user needs a *fresh* third-party access token at the exact moment of a tool call. Sometimes that action is sensitive and needs human approval. It always needs an audit trail.

**nominee** is the provider-neutral layer that solves this — the "Passport.js of agent auth."

```bash
npm install nominee
```

## Quickstart (No Signup Required)

Nominee is "install-and-go" by default. You don't need a SaaS account. You pass a function that returns a token (from your DB, env vars, etc.), and Nominee handles caching, freshness, and audit logging.

```ts
import { Nominee, tokens } from 'nominee'

const nominee = new Nominee({
  // 1. Give it a way to fetch tokens
  strategy: tokens(async ({ user, connection }) => db.getFreshToken(user, connection)),
  
  // 2. See what the agent is doing
  onAudit: (e) => console.log(`[Audit] ${e.agent} requested ${e.action}`),
  
  agent: 'triage-bot'
})

// 3. Get a fresh token. It's cached until just before expiry.
const token = await nominee.token({ user: 'alice', connection: 'github' })
```

## Built for your AI framework

Nominee plugs directly into your AI framework's tool system.

| Adapter | Package | Status |
|---|---|---|
| **Vercel AI SDK** | `nominee-ai` | ✅ Available |
| **Vercel Eve** | `nominee-eve` | ✅ Available |
| **Cloudflare Agents** | `nominee-ai` | ✅ Available |
| **Standalone Node** | `nominee` | ✅ Available |

## Human-in-the-Loop Approvals

Some actions are too sensitive for an AI to perform autonomously (like deleting a repo). Nominee lets you gate actions behind a human approval layer, independent of the LLM or framework.

```ts
// 1. The agent requests approval (blocks execution)
await nominee.approve({
  user: 'alice',
  action: 'repo.delete',
  detail: 'Delete repo: alice/old-project'
})
// 2. The agent resumes if approved!
```

Nominee fires `onApprovalRequest` which you can use to send a Slack notification or push a UI update. When the user clicks "Approve", your webhook calls `nominee.resolveApproval(id, 'approved')`.

## "Doesn't the Vercel AI SDK already have approvals?"

Yes, AI SDK v6 introduced tool approvals. But Nominee brings three crucial additions:
1. **Token Vault + Refresh**: Tool calls happen hours after authorization. We manage token lifecycle so you don't pass expired tokens into the tool.
2. **Provider-neutral**: Use it with Cloudflare Agents, Eve, or custom standalone agent loops, not just the AI SDK.
3. **Cross-framework Audit**: A unified audit trail across all your agents, regardless of what framework they were written in.

## Upgrading to Auth0 (Optional)

If you don't want to manage refresh tokens in your database, you can plug in `nominee-auth0`. This strategy uses Auth0's Token Vault and CIBA (Client-Initiated Backchannel Authentication) to manage tokens and push approvals directly to the user's phone.

```bash
npm install nominee nominee-auth0
```

```ts
import { Auth0 } from 'nominee-auth0'

const nominee = new Nominee({
  strategy: Auth0({
    domain: 'your-tenant.us.auth0.com',
    clientId: '...',
    clientSecret: '...'
  })
})
```

*Note: Nominee is entirely decoupled from Auth0. Auth0 is an optional strategy package.*

## Affiliation & Open Source

Nominee is built by Bharath @ Auth0. However, it is an independent, **neutral by design** library. The core has zero dependencies and zero proprietary lock-in. PRs for other providers (Clerk, Supabase, WorkOS, etc.) are enthusiastically welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) to build a strategy.
