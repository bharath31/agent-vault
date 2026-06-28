import { nomineeTool } from 'nominee-eve'
import { z } from 'zod'
import { getPR } from '../../lib/github.js'
import { nominee } from '../../lib/nominee.js'

export default nomineeTool({
  nominee,
  user: 'me',
  connection: 'github', // nominee fetches a fresh token at call time
  action: 'github.review_pr',
  description: 'Read a pull request: title, diff size, and merge state.',
  inputSchema: z.object({
    owner: z.string().describe('Repo owner, e.g. "bharath31"'),
    repo: z.string().describe('Repo name, e.g. "nominee-agent-testbed"'),
    number: z.number().describe('PR number'),
  }),
  async execute({ owner, repo, number }, { token }) {
    const pr = await getPR({ owner, repo, number, token: token! })
    return `PR #${pr.number} "${pr.title}" · +${pr.additions} −${pr.deletions} · ${pr.checks}`
  },
})
