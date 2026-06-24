# Durable agent that survives hibernation

The hardest case for agent auth isn't a long request — it's a **durable** one. An
agent that runs as a Cloudflare Durable Object (or Temporal/Inngest workflow)
**hibernates between steps and resumes hours later**. Any access token it grabbed
at the start is dead by the time it wakes.

This example shows the fix in ~50 lines: the agent stores a *resolver*, not a
token. On every wake it calls `nominee.token()` and gets a fresh one — the step
code never contains refresh logic.

## The one rule

Wire the strategy's credentials as **functions that read from durable storage**,
never a token captured into the Durable Object's serialized state:

```ts
strategy: OAuth2({
  connections: {
    github: {
      tokenEndpoint: env.TOKEN_ENDPOINT,
      clientId: 'durable-agent',
      // ✅ read durable creds on demand — survives hibernation
      refreshToken: async () => await state.storage.get('github_refresh_token'),
    },
  },
})
```

Then each step is just:

```ts
const token = await this.nominee.token({ user, connection: 'github' })
// always fresh, even after the DO slept past the token's TTL
```

Swap `OAuth2(...)` for `Auth0(...)` and that line pulls from Token Vault instead —
the agent code doesn't change. That's the point.

## Run it

```bash
npm i
npm run dev        # local Durable Object
# POST a session to start the agent (replace with a real refresh token)
curl -X POST localhost:8787 -d '{"user":"alice","refreshToken":"<github_refresh_token>"}'
```

> The captured-token failure mode (and nominee surviving it) is also shown live,
> with zero setup, in the homepage demo at [nominee.dev](https://nominee.dev/#proof).

## Why this matters

| | captured token | nominee |
|---|---|---|
| First step | works | works |
| Resume after TTL | **401 — agent dead** | fresh token, keeps going |
| Refresh code in agent | you write it | none |
| Swap provider later | rewrite | one line |
