/** Where the merge-access broker listens. */
export const BROKER_PORT = Number(process.env.BROKER_PORT ?? 4778)
export const BROKER_URL = `http://localhost:${BROKER_PORT}`

/**
 * Lifetime of a merge-access token issued by the broker (ms).
 *
 * Short BY DESIGN — this is just-in-time, least-privilege access to a privileged
 * action (merging a protected branch). Real orgs issue these for seconds-to-
 * minutes so a leaked token is near-useless. The broker enforces this for real;
 * nothing here is simulated. We use a few seconds so a paused agent's token
 * genuinely lapses within a demo instead of minutes later.
 */
export const JIT_TTL_MS = 4000

/**
 * How long the agent waits for human approval before it acts. Longer than
 * JIT_TTL_MS on purpose: a token requested up front is genuinely expired (the
 * broker rejects it) by the time the naive path tries to merge.
 */
export const APPROVAL_PAUSE_MS = 6000
