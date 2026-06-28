import { DEMO_TTL_MS } from './constants.js'

export interface PrRef {
  owner: string
  repo: string
  number: number
}
export interface PrSummary extends PrRef {
  title: string
  additions: number
  deletions: number
  checks: string
}
export interface MergeResult {
  merged: boolean
  url: string
}

const GH = 'https://api.github.com'
const headers = (token: string) => ({
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'nominee-github-agent',
  'X-GitHub-Api-Version': '2022-11-28',
})

/** Read a real pull request from GitHub. */
export async function getPR({
  owner,
  repo,
  number,
  token,
}: PrRef & { token: string }): Promise<PrSummary> {
  const res = await fetch(`${GH}/repos/${owner}/${repo}/pulls/${number}`, {
    headers: headers(token),
  })
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${await res.text()}`)
  const pr = (await res.json()) as {
    title: string
    additions?: number
    deletions?: number
    head?: { sha?: string }
    mergeable_state?: string
  }
  return {
    owner,
    repo,
    number,
    title: pr.title,
    additions: pr.additions ?? 0,
    deletions: pr.deletions ?? 0,
    checks: pr.mergeable_state ?? 'unknown',
  }
}

/**
 * Merge a real pull request on GitHub.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ ⚠️  SIMULATED EXPIRY — READ THIS                                            │
 * │                                                                            │
 * │ The merge below is a REAL GitHub API call. But the stale-token failure on  │
 * │ the naive path is **SIMULATED**, not a real GitHub rejection.              │
 * │                                                                            │
 * │ Why: a real GitHub token lives ~1 hour. We can't make a demo wait an hour  │
 * │ for it to actually expire, so we COMPRESS TIME: when the naive path passes │
 * │ `capturedAtMs`, we pretend the token's lifetime is DEMO_TTL_MS (a few      │
 * │ seconds) and throw the 401 OURSELVES — GitHub is never even called on that │
 * │ path. The real token is still valid; we are faking the expiry to show, in  │
 * │ seconds, the failure that would really happen an hour into a paused agent  │
 * │ session.                                                                   │
 * │                                                                            │
 * │ The nominee path never passes `capturedAtMs`, so it skips this fake check  │
 * │ and performs the REAL merge.                                               │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
export async function mergePR({
  owner,
  repo,
  number,
  token,
  capturedAtMs,
}: PrRef & { token: string; capturedAtMs?: number }): Promise<MergeResult> {
  // SIMULATED FAILURE (not a real GitHub 401): see the box above. We throw this
  // ourselves to stand in for a token that expired during a long, time-compressed
  // approval pause. No GitHub call happens here.
  if (capturedAtMs !== undefined && Date.now() - capturedAtMs > DEMO_TTL_MS) {
    throw new Error(
      'GitHub 401: Bad credentials — (SIMULATED) the token grabbed before the time-compressed approval pause has "expired".',
    )
  }
  const res = await fetch(`${GH}/repos/${owner}/${repo}/pulls/${number}/merge`, {
    method: 'PUT',
    headers: headers(token),
    body: JSON.stringify({ merge_method: 'merge' }),
  })
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${await res.text()}`)
  return { merged: true, url: `https://github.com/${owner}/${repo}/pull/${number}` }
}
