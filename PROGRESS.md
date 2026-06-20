# nominee — build progress

Legend: ⬜ todo · 🟦 in progress · ✅ done

## Phase 0 — Monorepo scaffolding ✅
pnpm workspace, tsconfig.base, biome, changesets, GH Actions CI + release.

## Phase 1 — Core engine (`nominee`) ✅
`strategy.ts` · `audit.ts` · `approval.ts` · `strategies/{tokens,memory,oauth2}.ts` · `nominee.ts` · `index.ts`.
Install-and-go default: `new Nominee({ strategy: (params) => token })`.
35 tests · typecheck + biome clean · dual ESM+CJS.

## Phase 2 — `nominee-auth0` ✅
`Auth0()` strategy: `getToken` (Token Vault federated exchange) + `requestApproval` (CIBA poll).
Hand-rolled HTTP, zero heavy deps. 6 tests (mocked HTTP). Dual build.
⚠️ Not yet validated against a live Auth0 tenant — do before 1.0.

## Phase 3 — `nominee-ai` (Vercel AI SDK) ✅
`nomineeTool()` + `withNominee()`. 6 tests. Dual build.
Covers Cloudflare Agents unchanged (`agents` has `ai@^6` peer).

## Phase 4 — `nominee-eve` (Vercel Eve) ✅
`defineTool` from `eve/tools`, branded, ESM-only. 6 tests. ESM-only build.

## Phase 5 — Examples + docs ✅
- ✅ `examples/standalone-node`
- ✅ `examples/vercel-ai-github`
- ✅ `examples/eve-agent`
- ✅ `README.md`, `CONTRIBUTING.md`, `llms.txt`
- ✅ Per-package READMEs for npm pages

## Phase 6 — Publish ✅
- ✅ `nominee@0.2.0` published
- ✅ `nominee-ai@2.0.0` published
- ✅ `nominee-auth0@2.0.0` published
- ✅ `nominee-eve@2.0.0` published
- ✅ GitHub Actions CI + release workflow

---

## Adapter coverage
Eve ✅ · Vercel AI SDK ✅ · Cloudflare Agents ✅ (via `nominee-ai`) · standalone ✅.
`nominee-cloudflare` (Durable Object approval storage) = post-launch fast-follow.

## Post-launch
- Validate `nominee-auth0` against a live Auth0 tenant.
- Implement `can()` / FGA in a v0.2 release.
- Community strategies: Clerk, Supabase, WorkOS.
