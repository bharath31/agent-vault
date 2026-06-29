import type { Nominee } from 'nominee'
import { nomineeTool } from 'nominee-ai'
import { z } from 'zod'

const GH = 'https://api.github.com'
const ghHeaders = (token: string) => ({
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'nominee-ai-sdk-github-agent',
  'X-GitHub-Api-Version': '2022-11-28',
})

const prInput = z.object({
  owner: z.string(),
  repo: z.string(),
  number: z.number(),
})

/**
 * Build the two GitHub tools, both brokered by one nominee instance:
 *  - get_pr   — a read. No approval; nominee just supplies a fresh token.
 *  - merge_pr — a write. approval:true, so it pauses for a human, and the token
 *               is fetched at merge time (even after the approval pause).
 */
export function createTools(nominee: Nominee, user: string) {
  const get_pr = nomineeTool({
    nominee,
    user,
    connection: 'github',
    description: 'Read a GitHub pull request: title, diff size, and mergeability.',
    inputSchema: prInput,
    async execute({ owner, repo, number }, { token }) {
      const res = await fetch(`${GH}/repos/${owner}/${repo}/pulls/${number}`, {
        headers: ghHeaders(token!),
      })
      if (!res.ok) return { error: `GitHub ${res.status}: ${await res.text()}` }
      const pr = (await res.json()) as {
        title: string
        additions?: number
        deletions?: number
        mergeable_state?: string
      }
      return {
        title: pr.title,
        additions: pr.additions ?? 0,
        deletions: pr.deletions ?? 0,
        mergeable_state: pr.mergeable_state ?? 'unknown',
      }
    },
  })

  const merge_pr = nomineeTool({
    nominee,
    user,
    connection: 'github',
    approval: true,
    action: 'github.merge_pr',
    description: "Merge a GitHub pull request on the user's behalf. Requires human approval.",
    inputSchema: prInput,
    async execute({ owner, repo, number }, { token }) {
      const res = await fetch(`${GH}/repos/${owner}/${repo}/pulls/${number}/merge`, {
        method: 'PUT',
        headers: ghHeaders(token!),
        body: JSON.stringify({ merge_method: 'merge' }),
      })
      if (!res.ok) return { merged: false, error: `GitHub ${res.status}: ${await res.text()}` }
      return { merged: true, url: `https://github.com/${owner}/${repo}/pull/${number}` }
    },
  })

  return { get_pr, merge_pr }
}
