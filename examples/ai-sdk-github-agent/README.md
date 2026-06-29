# Flagship: an AI SDK agent that merges a PR on your behalf

A Vercel AI SDK agent that reviews a GitHub pull request and merges it **for you** —
with three properties that are hard to get right by hand and that nominee gives you
with no SaaS:

1. **Fresh token at merge time.** The GitHub token is resolved at the moment of the
   merge, not grabbed up front — so it's still valid even after the agent pauses for
   your approval. On a provider that rotates refresh tokens, nominee persists the
   rotated token (`onRefreshToken`) so a long run keeps working.
2. **Human approval.** `merge_pr` is `approval: true`. The agent blocks until a human
   approves; `get_pr` (a read) doesn't.
3. **Full audit.** Every token fetch and approval decision for the merge is appended
   to `audit.log`, attributed to the `github-agent` identity.

## Run it

```bash
pnpm install
cp .env.example .env   # GitHub App creds + a seed refresh token, OpenRouter key
node --env-file=.env --import tsx agent.ts <owner> <repo> <pr-number>
```

What you'll see: `get_pr` runs immediately (a read), then `merge_pr` triggers an
approval prompt and pauses; after approval, nominee fetches a fresh token and the
merge goes through. Tail the trail:

```bash
cat audit.log
# {"type":"approval.requested","action":"github.merge_pr",...,"agent":"github-agent"}
# {"type":"approval.resolved","action":"github.merge_pr","decision":"approved",...}
# {"type":"token.issued","connection":"github",...,"agent":"github-agent"}
```

The integration is just two `nomineeTool(...)` wrappers — see [`tools.ts`](./tools.ts) —
over the same `nominee` instance in [`agent.ts`](./agent.ts).

## Why a GitHub *App* (or token-expiring OAuth app)?

Classic GitHub tokens don't expire and don't rotate, so they don't exercise the
interesting case. GitHub **Apps** (and OAuth apps with "Expire user authorization
tokens" enabled) issue short-lived access tokens with **rotating** refresh tokens —
exactly the shape that breaks naive refresh code. That's the case nominee handles;
see [`../token-refresh-correctness`](../token-refresh-correctness) for the proof.

## When you don't need this

If you're on Eve or already use a managed connector (Vercel Connect, Auth0 Token
Vault), use it — nominee is for the framework-neutral, no-lock-in, standalone case.

## Demo recording

See [`record-gif.md`](./record-gif.md) for the steps to capture the ~30s demo GIF.
