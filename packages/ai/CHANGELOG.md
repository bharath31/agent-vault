# nominee-ai

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
