// Real GitHub calls. Used server-side by the merge-access broker (which holds the
// privileged GitHub credential) and by the Auth0 Level-3 tool. No simulation.

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

/** Merge a real pull request on GitHub. */
export async function mergePR({
  owner,
  repo,
  number,
  token,
}: PrRef & { token: string }): Promise<MergeResult> {
  const res = await fetch(`${GH}/repos/${owner}/${repo}/pulls/${number}/merge`, {
    method: 'PUT',
    headers: headers(token),
    body: JSON.stringify({ merge_method: 'merge' }),
  })
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${await res.text()}`)
  return { merged: true, url: `https://github.com/${owner}/${repo}/pull/${number}` }
}
