# CLAUDE.md

This repo's guidance for coding agents lives in **[AGENTS.md](./AGENTS.md)** —
read it first. It covers what nominee is, the two non-negotiable design
commitments (install-and-go default; dependency-free core), the monorepo layout,
the public API, commands, conventions, and gotchas.

## Quick orientation

- **What it is:** provider-neutral identity + token delegation for AI agents.
  Fresh third-party tokens at call time, human-in-the-loop approval, audit.
- **Default path = no signup:** `new Nominee({ strategy: ({connection}) => process.env[...] })`.
  Auth0 (`nominee-auth0`) is the optional managed upgrade (Token Vault + CIBA).
- **Packages:** `nominee` (core, zero deps) · `nominee-ai` (Vercel AI SDK, also
  Cloudflare) · `nominee-eve` (Vercel Eve) · `nominee-auth0` (optional).

## Before you commit

```bash
pnpm -r build && pnpm -r test && pnpm -r typecheck && pnpm biome check .
```

All four must be green. Keep the core dependency-free and the public API tiny — DX/AX is a stated product priority.
