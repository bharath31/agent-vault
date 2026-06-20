# cloudflare-agent — nominee on Cloudflare Workers AI

A deployable Cloudflare Worker. A **Workers AI model** (no API key) drives a tool
call; **nominee** injects a fresh token and gates the action behind approval. It's
the same AI SDK stack the **Cloudflare Agents SDK** is built on, so `nomineeTool`
drops into a full `agents` app unchanged.

## Run locally

```bash
pnpm install            # from the repo root
pnpm --filter cloudflare-agent dev
# open http://localhost:8787/?task=Close%20issue%201242%20in%20acme/api
```

## Deploy

```bash
pnpm --filter cloudflare-agent deploy
```

Deploys to `https://nominee-cf-agent-demo.<your-subdomain>.workers.dev`. The `[ai]`
binding in `wrangler.toml` gives the Worker access to Cloudflare Workers AI — no
keys to manage.

## What you get back

A JSON trace of the run: the model's tool calls, the tool results (with a preview
of the **fresh token** nominee injected), and the **audit** stream
(`token.issued`, `approval.requested`, `approval.resolved`, …).

## Make it real

- Swap the demo `strategy` for `Auth0(...)` (Token Vault) or `OAuth2(...)`.
- Replace the auto-approve `onApprovalRequest` with a real push (e.g. Auth0 CIBA),
  and persist the audit stream.
