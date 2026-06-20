# AGENTS.md — nominee

Guide for coding agents (and humans) working in this repo. Read this first.

## What nominee is

**Identity and token delegation for AI agents.** An agent acting on behalf of a
user needs a *fresh* third-party access token at the moment of a tool call,
sometimes gated behind human approval, always auditable. nominee is the
provider-neutral layer that does this — the "Passport.js of agent auth."

**Two design commitments that must not be broken:**

1. **Install-and-go by default.** The default path requires *no signup, no
   service*. You pass a plain function that returns a token (env var, your DB, a
   literal). nominee handles freshness/caching, human-in-the-loop approval, and
   audit on top. Auth0 (`nominee-auth0`) is the **optional** managed upgrade
   (Token Vault + CIBA), never required.
2. **Core stays dependency-free.** `packages/core` has zero runtime deps. Any
   provider/runtime dependency lives in a strategy or adapter package.

**Design rule (the whole point):** never hand out a captured token. Callers ask
`nominee.token()` at call time; the engine caches per `(user, connection)` until
just before expiry, then refreshes transparently. This is what survives
long-running / durable agent execution.

## Monorepo layout

```
packages/
  core/    → published as `nominee`        — engine, Strategy interface, tokens()/OAuth2()/Memory(), approval engine, audit. NO provider deps.
  ai/      → `nominee-ai`                  — Vercel AI SDK adapter (also covers Cloudflare Agents). DUAL esm+cjs.
  eve/     → `nominee-eve`                 — Vercel Eve adapter. ESM-ONLY (Eve is ESM-only; defineTool brands its output so we must call it).
  auth0/   → `nominee-auth0`               — optional Auth0 strategy: Token Vault getToken + CIBA requestApproval. Hand-rolled HTTP, zero heavy deps.
examples/  → standalone-node, vercel-ai-github, eve-agent
```

## Public API (keep it tiny — DX/AX is a first principle)

```ts
import { Nominee } from 'nominee'

const nominee = new Nominee({
  strategy: ({ connection }) => process.env[`${connection.toUpperCase()}_TOKEN`]!,
  onApprovalRequest: async (req) => notifyUser(req),   // optional HITL
  onAudit: (e) => log(e),                              // optional audit sink
  agent: 'triage-bot',                                 // optional, for audit chain
})

await nominee.token({ user, connection })          // fresh token, auto-refreshed
await nominee.approve({ user, action, detail })     // resolves on approve, throws ApprovalDeniedError on deny/expire
nominee.resolveApproval(id, 'approved'|'denied')    // settle built-in approvals (from your webhook)
await nominee.can({ user, action, resource })       // FGA — interface only; throws unless strategy implements it
nominee.on((event) => ...)                           // audit stream; returns unsubscribe
```

Bundled core strategies: `tokens(fn)` (named function strategy), `OAuth2({connections})` (generic refresh-token, zero-dep), `Memory({tokens})` (dev/tests).

Adapters both expose `nomineeTool(config)` and `withNominee(nominee, defaults)`.
Adapter tool config adds: `connection` (inject fresh token into execute ctx),
`approval: boolean` + `action` (gate via `nominee.approve`), `user` (string or
resolver). `execute(input, ctx)` where ctx = `{ token?, user, ai|eve }`.

## Commands

```bash
pnpm install                 # workspace install (Node 20+, pnpm 10)
pnpm -r build                # tsup build all packages (esm/cjs + dts)
pnpm -r test                 # vitest
pnpm -r typecheck            # tsc --noEmit
pnpm biome check .           # lint+format check
pnpm biome check --write .   # autofix
```

Per-package: `pnpm --filter nominee test`, `pnpm --filter nominee-ai build`, etc.

## Conventions

- TypeScript strict, `verbatimModuleSyntax` → use `import type` for types and
  `.js` extensions on relative imports.
- Biome formatting: single quotes, no semicolons, trailing commas, width 100.
  `noExplicitAny` is OFF; `noNonNullAssertion` is OFF in test/example files only.
- Each package: `tsup.config.ts`, `tsconfig.json` (extends `../../tsconfig.base.json`,
  adds `types: ["node"]`), `src/index.ts` barrel, `test/*.test.ts`.
- Conventional commit messages.

## Gotchas

- **pnpm ignores build scripts** for `esbuild`/`@biomejs/biome` by default. They
  are listed in root `package.json` `pnpm.onlyBuiltDependencies`; if a fresh
  clone fails to build, run `pnpm rebuild esbuild @biomejs/biome`.
- **AI SDK v6 `tool()` generics** don't unify with our Zod-inferred wrapper —
  `packages/ai/src/index.ts` casts via `unknown` at the `tool()` boundary on
  purpose. Public types stay precise (`Tool<z.infer<TSchema>, TOutput>`).
- **Eve `defineTool` brands its output and rejects raw objects** — the eve
  adapter MUST import and call `defineTool` from `eve/tools`. Eve is ESM-only, so
  `nominee-eve` is ESM-only too.
- **Auth0 contract** (hand-rolled HTTP, zero heavy deps):
  - Token Vault: `POST /oauth/token`, grant `urn:auth0:params:oauth:grant-type:token-exchange:federated-connection-access-token`.
  - CIBA: `POST /bc-authorize` → `{auth_req_id, interval, expires_in}`, then poll
    `POST /oauth/token` grant `urn:openid:params:grant-type:ciba`.
  - Not yet validated against a live tenant — do that before 1.0.
