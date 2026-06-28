---
"nominee-auth0": minor
---

Add a zero-config `auth0()` strategy: it resolves `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`,
`AUTH0_CLIENT_SECRET`, `AUTH0_REFRESH_TOKEN`, and `AUTH0_USER_SUB` from the
environment, enables CIBA automatically when a subject is present, and falls back
to a built-in mock (short-TTL token + auto-approve) when unconfigured — so an
example or test runs with zero setup, and the *same* call becomes real Token Vault
+ CIBA once the env is set. Also exports `MOCK_TTL_MS`.

Fixes CIBA `bc-authorize`: `login_hint` is now sent as the Auth0-required
`{ format: 'iss_sub', iss, sub }` JSON object (a bare subject was rejected with
"login_hint must be a valid JSON"). A pre-built JSON string is passed through
unchanged. The refresh-token read is also deferred to call time, so a missing
`AUTH0_REFRESH_TOKEN` surfaces when a token is requested rather than crashing at
strategy construction.
