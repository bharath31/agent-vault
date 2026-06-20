# nominee — build progress

Tracking against the approved plan (`~/.claude/plans/then-create-a-plan-bright-penguin.md`).
Legend: ⬜ todo · 🟦 in progress · ✅ done

> **HANDOFF — pick up here.** Core + all three adapters/strategy are built,
> tested, and green (53 tests). What's left is **Phase 4 (examples + README +
> AGENTS/CLAUDE done) and Phase 5 (publish)**. Exact next steps at the bottom.
> Always finish with: `pnpm -r build && pnpm -r test && pnpm -r typecheck && pnpm biome check .`

---

## Phase 0 — Monorepo scaffolding ✅
pnpm workspace, tsconfig.base, biome, changesets, GH Actions CI+release, native build approval.

## Phase 1 — Core engine (`nominee`) ✅  → standalone, zero deps
`strategy.ts` · `audit.ts` · `approval.ts` · `strategies/{tokens,memory,oauth2}.ts` · `nominee.ts` · `index.ts`.
**Install-and-go default:** `new Nominee({ strategy: (params) => token })` — function strategy, no provider.
35 tests · typecheck + biome clean · dual ESM+CJS.

## Phase 3 — `nominee-ai` (Vercel AI SDK) ✅  ← launch demo + Cloudflare coverage
Verified vs real `ai@6`. `nomineeTool()` + `withNominee()`. 6 tests. Dual build.
Covers Cloudflare Agents unchanged (`agents` has `ai@^6` peer).

## Phase 7 — `nominee-eve` (Vercel Eve) ✅  ← attention driver
Verified vs real `eve@0.11.7` (`defineTool` from `eve/tools`, branded, ESM-only). 6 tests. ESM-only build.

## Phase 2 — `nominee-auth0` ✅  ← optional managed upgrade
`Auth0()` strategy: `getToken` (Token Vault federated exchange) + `requestApproval` (CIBA poll).
Hand-rolled HTTP from verified `@auth0/ai` source; zero heavy deps. 6 tests (mocked HTTP). Dual build.
⚠️ **Not yet validated against a live Auth0 tenant** — do before 1.0. `can()`/`exchange()` = v0.2.

## Phase 4 — Examples + docs ✅
- ✅ `AGENTS.md` (repo + AX guide) · ✅ `CLAUDE.md`
- ✅ `examples/standalone-node` — Nominee with a function/OAuth2 strategy, show token refresh + approve()/resolveApproval() + audit. NO Auth0.
- ✅ `examples/vercel-ai-github` — AI SDK agent, `nomineeTool` with `connection:'github'` + `approval:true`; prints audit chain. Sample app.
- ✅ `examples/eve-agent` — minimal Eve `agent/tools/*.ts` using `nominee-eve`.
- ✅ `README.md` — **the compelling "why" for every agent dev.** Cold-open pain
  (auth'd at 9am, dead by 3pm / silent 401s in durable runs) → 6-line install-and-go
  quickstart (NO signup) → approval demo → audit → "Auth0 optional" → adapters table
  (Eve/AI/Cloudflare/standalone) → "doesn't AI SDK v6 already do approval?" rebuttal
  (we add token vault + refresh + provider-neutral + cross-framework audit) →
  affiliation disclosure (built by Bharath @ Auth0; neutral by design, PRs for other
  providers welcome). Keep it simple + straightforward (explicit user ask).
- ✅ `CONTRIBUTING.md` — invite provider strategies (Clerk/Supabase); document the `Strategy` contract.
- ✅ (nice-to-have) `llms.txt` at root for AX.

## Phase 5 — Verify, version, publish ⬜
- ⬜ `npm pack` each package; check tarball `exports`/`files`/dual outputs.
- ⬜ Create npm **org `nominee`** (https://www.npmjs.com/org/create) for `nominee-*`.
      Fallback if blocked: unscoped `nominee-ai`/`nominee-eve`/`nominee-auth0` (filter risk).
- ⬜ Auth token: user uses an **npm Automation token** (passkey-only acct can't OTP).
      `npm config set //registry.npmjs.org/:_authToken <TOKEN>` then publish. Revoke after.
- ⬜ `pnpm changeset` (minor for all) → `pnpm changeset version` → `pnpm -r publish --dry-run` → real publish.
- ⬜ Bump core `nominee` 0.0.1 → 0.1.0 on publish.

---

## Adapter coverage
Eve ✅ · Vercel AI SDK ✅ · Cloudflare Agents ✅ (via `nominee-ai`, document it) · standalone ✅.
Dedicated `nominee-cloudflare` (Durable Object approval storage) = post-launch fast-follow.

## Repo facts for the next agent
- GitHub: `github.com/bharath31/nominee`, default branch `main`, currently ONE commit
  (`init`). Work below is uncommitted unless a commit was just made — `git status` first.
- npm: `nominee@0.0.1` placeholder published. `nominee-*` org NOT yet created.
- Node 20 / pnpm 10 locally. Plan file: `~/.claude/plans/then-create-a-plan-bright-penguin.md`.
- Read **AGENTS.md** for architecture, conventions, and gotchas (type casts, ESM-only eve, Auth0 contract).

## Immediate next steps (in order)
1. Phase 5 publish (needs user for npm org + token).
   - Create npm org `nominee`.
   - Setup npm Automation token.
   - Run `pnpm changeset` and publish.
