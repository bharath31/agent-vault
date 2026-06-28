// Client for the merge-access broker. The agent never touches the GitHub
// credential — it asks the broker for short-lived access, then acts through it.
import { BROKER_URL } from './constants.js'
import type { MergeResult, PrRef, PrSummary } from './github.js'

export interface Access {
  token: string
  expiresAt: number
}

/** Error from the broker. `expired` is true only when access actually lapsed —
 *  so callers can tell a stale token apart from a real GitHub failure (conflict,
 *  already-merged, branch protection) the broker surfaces. */
export class BrokerError extends Error {
  expired: boolean
  constructor(message: string, expired = false) {
    super(message)
    this.name = 'BrokerError'
    this.expired = expired
  }
}

const post = async (path: string, body?: unknown) => {
  const res = await fetch(`${BROKER_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }).catch(() => {
    throw new BrokerError(
      `merge-access broker is not reachable at ${BROKER_URL}. Start it in another terminal: pnpm broker`,
    )
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const d = data as { error?: string; message?: string }
    if (d.error === 'access_expired') {
      throw new BrokerError('merge-access token expired — the broker rejected it (HTTP 403).', true)
    }
    throw new BrokerError(d.message || `broker ${path} failed (${res.status})`)
  }
  return data
}

/** Request a short-lived, just-in-time merge-access token. */
export const requestAccess = (): Promise<Access> => post('/access') as Promise<Access>

/** Read a PR through the broker (requires a valid access token). */
export const brokerReadPR = (token: string, ref: PrRef): Promise<PrSummary> =>
  post('/pr', { token, ...ref }) as Promise<PrSummary>

/** Merge a PR through the broker (requires a valid access token). */
export const brokerMerge = (token: string, ref: PrRef): Promise<MergeResult> =>
  post('/merge', { token, ...ref }) as Promise<MergeResult>
