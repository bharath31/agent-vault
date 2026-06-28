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
  simulated: boolean
}

/** A token minted by the built-in mock strategy never hits real GitHub. */
export function isMockToken(token: string): boolean {
  return token.startsWith('mock-')
}

const GH = 'https://api.github.com'
const headers = (token: string) => ({
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'nominee-github-agent',
})

/** Read a PR. Simulated in mock mode (no real token to use). */
export async function getPR({
  owner,
  repo,
  number,
  token,
}: PrRef & { token: string }): Promise<PrSummary> {
  if (isMockToken(token)) {
    return {
      owner,
      repo,
      number,
      title: 'Fix flaky test',
      additions: 12,
      deletions: 3,
      checks: 'passing',
    }
  }
  const res = await fetch(`${GH}/repos/${owner}/${repo}/pulls/${number}`, { headers: headers(token) })
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${await res.text()}`)
  const pr = (await res.json()) as { title: string; additions?: number; deletions?: number }
  return {
    owner,
    repo,
    number,
    title: pr.title,
    additions: pr.additions ?? 0,
    deletions: pr.deletions ?? 0,
    checks: 'see GitHub',
  }
}

/**
 * Merge a PR. `capturedAtMs` is supplied ONLY by the naive path; when present we
 * enforce the compressed demo window and reject a token grabbed before the
 * approval pause — the genuine stale-token failure, on a shrunk clock. The
 * nominee path never passes it (its token is fresh at call time).
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
      'GitHub 401: Bad credentials — the token was grabbed before the approval pause and has expired.',
    )
  }
  if (isMockToken(token)) {
    return {
      merged: true,
      url: `https://github.com/${owner}/${repo}/pull/${number}`,
      simulated: true,
    }
  }
  const res = await fetch(`${GH}/repos/${owner}/${repo}/pulls/${number}/merge`, {
    method: 'PUT',
    headers: headers(token),
    body: JSON.stringify({ merge_method: 'merge' }),
  })
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${await res.text()}`)
  return {
    merged: true,
    url: `https://github.com/${owner}/${repo}/pull/${number}`,
    simulated: false,
  }
}
