# nominee-supabase

## 2.0.0

### Patch Changes

- nominee@2.0.0

## 1.1.0

### Minor Changes

- Initial release. A zero-dependency Supabase strategy: store provider tokens in a Supabase table and let nominee read and refresh them. Reads a per-(user, connection) row over PostgREST, returns a cached access token while fresh, otherwise refreshes the stored refresh token at the provider and writes the fresh one back.

### Patch Changes

- Updated dependencies
  - nominee@1.1.0
