# AGENTS.md - nominee

Guide for AI coding agents and contributors working in this repository.

## Project

nominee is identity and token delegation for AI agents. Agents call
`nominee.token()` at tool-execution time to get a fresh third-party access token
for a user and connection. Sensitive actions can be gated by human approval, and
privileged operations emit audit events.

Two design commitments matter most:

1. **Install-and-go by default.** Core usage should work with a plain function
   that returns a token. Auth0 is an optional managed strategy, not a
   requirement.
2. **Core stays dependency-free.** `packages/core` must have zero runtime
   dependencies. Provider and framework dependencies belong in strategy or
   adapter packages.

## Layout

```text
packages/
  core/   published as nominee        - engine, Strategy interface, built-in strategies
  ai/     published as nominee-ai     - Vercel AI SDK and Cloudflare Agents adapter
  eve/    published as nominee-eve    - Vercel Eve adapter
  auth0/  published as nominee-auth0  - optional Auth0 strategy
examples/
  github-agent/   golden Eve + Auth0 example (PR review-and-merge agent)
site/
  static microsite for nominee.dev
  agent-worker/   deployed nominee.dev/agent worker (Cloudflare Durable Object)
```

## Public API Shape

```ts
import { Nominee, tokens } from 'nominee'

const nominee = new Nominee({
  strategy: tokens(({ user, connection }) => db.getFreshToken(user, connection)),
  onApprovalRequest: async (req) => notifyUser(req),
  onAudit: (event) => auditDb.insert(event),
  agent: 'triage-bot',
})

await nominee.token({ user, connection })
await nominee.approve({ user, action, detail })
nominee.resolveApproval(id, 'approved')
await nominee.can({ user, action, resource })
nominee.on((event) => auditDb.insert(event))
```

Adapters expose `nomineeTool(config)` and `withNominee(nominee, defaults)`.
Adapter config uses `inputSchema`, optional `connection`, optional `approval`,
optional `action`, and an `execute(input, ctx)` function. The adapter context is
`{ token?, user, ai }` for `nominee-ai` and `{ token?, user, eve }` for
`nominee-eve`.

## Commands

```bash
pnpm install
pnpm -r build
pnpm -r test
pnpm -r typecheck
pnpm check
pnpm format
```

Use per-package filters when working narrowly:

```bash
pnpm --filter nominee test
pnpm --filter nominee-ai build
```

## Conventions

- TypeScript strict mode is enabled.
- Use `import type` for type-only imports.
- Use `.js` extensions on relative TypeScript imports.
- Biome formatting uses single quotes, no semicolons, trailing commas, and
  100-character line width.
- Keep public APIs small and documented.
- Prefer focused tests in `test/*.test.ts` next to the package being changed.
- Do not add runtime dependencies to `packages/core`.

## Documentation

First-touch docs live in three places:

- `README.md` for the GitHub landing page.
- `packages/*/README.md` for npm package pages.
- `site/` for nominee.dev.

Keep examples aligned with the actual exported API before publishing.
