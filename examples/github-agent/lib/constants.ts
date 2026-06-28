import { MOCK_TTL_MS } from 'nominee-auth0'

/**
 * SIMULATED token lifetime for the demo. A real GitHub token lasts ~1 hour; we
 * can't make a demo wait an hour for it to actually expire, so we shrink its
 * pretend lifetime to a few seconds. The naive path then "expires" the token it
 * captured (a 401 our own code throws — see lib/github.ts), standing in for the
 * real expiry that would happen an hour into a paused agent session.
 */
export const DEMO_TTL_MS = MOCK_TTL_MS

/** How long the agent "pauses for approval" (also time-compressed). Intentionally
 *  > DEMO_TTL_MS so a token captured before the pause is "stale" by merge time. */
export const APPROVAL_PAUSE_MS = 5000
