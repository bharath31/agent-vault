# Your agent's OAuth refresh is probably broken

A runnable proof. No mocks-that-cheat: the OAuth server here really expires
access tokens (2s TTL), really **rotates** refresh tokens (each refresh burns the
old one — like GitHub, Google one-time-use, Okta, Auth0 rotation), and the
`/token` endpoint has real latency so concurrent refreshes really overlap.

```bash
pnpm install
node run.mjs
```

```
A) naive (hold access token across pause):   resource → 401 token_expired
B) nominee (refresh at call time):           before → 200 OK | after pause → 200 OK
C) nominee + 8 concurrent calls:             network refreshes = 1 (single-flight) | resource 200s = 8/8
D) refresh WITHOUT single-flight (8 concurrent): network refreshes = 8 | invalid_grant failures = 7/8
```

## What each row shows

- **A — the trap.** An agent grabs an access token up front, then pauses for
  human approval. By the time it acts, the token has expired: `401`. This is the
  single most common agent-auth bug.
- **B — resolve at call time.** Ask for a token *at the moment of the tool call*,
  every time. nominee returns a fresh one across the pause: `200/200`.
- **C — concurrency.** A real agent fires many tool calls at once. Eight
  concurrent `token()` calls collapse into **one** network refresh (single-flight)
  and all eight succeed: `8/8`.
- **D — why this isn't a 5-line happy path.** The obvious fix ("just refresh the
  token") without single-flight: eight calls each read the stored refresh token
  and refresh independently. Rotation means the first refresh **invalidates** the
  token the other seven are still holding → `invalid_grant`, **7/8 fail**, and
  your stored refresh token can end up corrupted.

## The one-line difference

A & D are the natural-but-wrong first attempts. B & C are nominee — the agent
code doesn't change, you just ask nominee for the token instead of holding one:

```js
import { Nominee, OAuth2 } from 'nominee'

const nominee = new Nominee({
  strategy: OAuth2({
    connections: {
      demo: {
        tokenEndpoint: TOKEN_URL,
        clientId: CLIENT_ID,
        refreshToken: () => store.get('alice').refreshToken,
        // The line that makes rotation correct: persist the rotated token.
        onRefreshToken: (_p, rt) =>
          store.set('alice', { ...store.get('alice'), refreshToken: rt }),
      },
    },
  }),
})

// At the moment of the tool call — never held across the pause:
const token = await nominee.token({ user: 'alice', connection: 'demo' })
```

nominee does the proactive refresh, the single-flight coalescing, and the atomic
rotation persistence (`onRefreshToken`) for you. That's the whole correctness
kernel — see [`packages/core`](../../packages/core).

## When you DON'T need this

If your provider issues long-lived, non-rotating tokens and your agent never
pauses or fans out, the naive path is fine. If you're already on a managed token
layer (Auth0 Token Vault, Vercel Connect, Nango), use it — nominee is for the
framework-neutral, no-SaaS, bring-your-own-store tail.

## Files

- `oauth-server.mjs` — the honest mock provider (short TTL + rotation + latency).
- `store.mjs` — a file-backed durable store standing in for a DB row / DO storage.
- `run.mjs` — the four scenarios above.
