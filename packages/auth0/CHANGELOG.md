# nominee-auth0

## 2.0.1

### Patch Changes

- Release 2.0.1 and fix unintended major version bumps.

  Two things in one release:

  1. **Unblock publishing.** The `2.0.0` version number was burned on npm for
     `nominee-ai`, `nominee-eve`, and `nominee-auth0` (published then unpublished
     on 2026-06-20), so npm permanently rejects republishing it and the Release
     workflow stayed red. Bumping to `2.0.1` publishes a fresh, clean version.

  2. **Fix the versioning.** `2.0.0` itself was an _accident_: a single
     `nominee-auth0: minor` changeset got escalated to a whole-group **major** by
     changesets' `fixed`-group behavior. The config now uses `linked` instead of
     `fixed`, so the packages still share a version line but a `minor` changeset
     bumps a minor and a `patch` bumps a patch — no surprise majors.

- Updated dependencies
  - nominee@2.0.1

## 2.0.0

### Minor Changes

- e3a3412: Add a zero-config `auth0()` strategy: it resolves `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`,
  `AUTH0_CLIENT_SECRET`, `AUTH0_REFRESH_TOKEN`, and `AUTH0_USER_SUB` from the
  environment, enables CIBA automatically when a subject is present, and falls back
  to a built-in mock (short-TTL token + auto-approve) when unconfigured — so an
  example or test runs with zero setup, and the _same_ call becomes real Token Vault

  - CIBA once the env is set. Also exports `MOCK_TTL_MS`.

  Fixes CIBA `bc-authorize`: `login_hint` is now sent as the Auth0-required
  `{ format: 'iss_sub', iss, sub }` JSON object (a bare subject was rejected with
  "login_hint must be a valid JSON"). A pre-built JSON string is passed through
  unchanged. The refresh-token read is also deferred to call time, so a missing
  `AUTH0_REFRESH_TOKEN` surfaces when a token is requested rather than crashing at
  strategy construction.

### Patch Changes

- nominee@2.0.0

## 1.1.0

### Patch Changes

- Updated dependencies
  - nominee@1.1.0

## 1.0.0

### Patch Changes

- Updated dependencies [f1593cf]
- Updated dependencies
  - nominee@1.0.0
