# Contributing to nominee

Thank you for your interest in contributing to Nominee! Nominee's goal is to be the provider-neutral "Passport.js of agent auth."

The core engine (`nominee`) is entirely dependency-free. We welcome pull requests for new adapters and strategies.

## Adding a new Strategy

A strategy is a package that provides tokens and handles human approvals. Currently, we have the built-in `tokens` strategy and `nominee-auth0`. We'd love community strategies for Clerk, Supabase, WorkOS, and others.

To build a strategy, implement the `Strategy` interface from `nominee`:

```ts
import type { Strategy, GetTokenParams, ApprovalParams, ApprovalResult } from 'nominee'

export function MyProvider(config: MyConfig): Strategy {
  return {
    name: 'my-provider',

    // 1. Return a fresh token for the given user and connection.
    // If the token has an `expiresAt` (ms since epoch), nominee will cache it.
    async getToken(params: GetTokenParams) {
      const response = await fetch('...')
      return {
        token: response.access_token,
        expiresAt: Date.now() + (response.expires_in * 1000)
      }
    },

    // 2. (Optional) Request human approval natively via your provider
    // (e.g. CIBA push notification). If not provided, nominee will fall back
    // to its built-in generic approval engine.
    async requestApproval(params: ApprovalParams): Promise<ApprovalResult> {
      // e.g. Start a push notification flow and poll until approved/denied
      return {
        id: 'some-id',
        decision: 'approved' // or 'denied' or 'expired'
      }
    },

    // 3. (Optional) Fine-grained authorization check (FGA)
    async can(params: AuthzParams): Promise<boolean> {
      return true
    }
  }
}
```

If you are building a strategy for a major provider, you can open a PR to add it to the `nominee-*` monorepo namespace.

## Local Development

The monorepo uses `pnpm` workspaces and `tsup` for bundling.

1. **Install dependencies:** `pnpm install`
2. **Build everything:** `pnpm -r build`
3. **Run tests:** `pnpm -r test`
4. **Lint and format:** `pnpm check` and `pnpm format`

Please ensure tests pass and code is formatted with Biome before submitting a PR.
