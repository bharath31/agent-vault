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
 * `capturedAtMs` is supplied ONLY by the naive (no-nominee) path. It models a
 * long-running agent that grabbed a token up front: we COMPRESS TIME — treat the
 * captured token as past its lifetime after DEMO_TTL_MS — so the stale-token
 * failure that would really happen ~1h later is visible in seconds. This time
 * compression is the demo's only simulation; the merge itself is a real GitHub
 * call. The nominee path never passes `capturedAtMs` (its token is fresh at call
 * time), so it always performs the real merge.
 */
export async function mergePR({
  owner,
  repo,
  number,
  token,
  capturedAtMs,
}: PrRef & { token: string; capturedAtMs?: number }): Promise<MergeResult> {
  if (capturedAtMs !== undefined && Date.now() - capturedAtMs > DEMO_TTL_MS) {
    throw new Error(
      'GitHub 401: Bad credentials — the token grabbed before the (time-compressed) approval pause has expired.',
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
