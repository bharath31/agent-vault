import { MOCK_TTL_MS } from 'nominee-auth0'

/** Compressed token-lifetime window for the demo. A real Token Vault token lasts
 *  ~1h; we shrink it so a stale-token failure is visible in seconds. */
export const DEMO_TTL_MS = MOCK_TTL_MS

/** How long the agent "pauses for approval". Intentionally > DEMO_TTL_MS so a
 *  token captured before the pause is stale by the time the naive path acts. */
export const APPROVAL_PAUSE_MS = 5000
