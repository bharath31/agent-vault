import { nomineeTool } from 'nominee-eve'
import { z } from 'zod'
import { brokerReadPR } from '../../lib/broker.js'
import { nominee } from '../../lib/nominee.js'

export default nomineeTool({
  nominee,
  user: 'me',
  connection: 'github', // nominee gets fresh merge-access at call time
  action: 'github.review_pr',
  description: 'Read a pull request: title, diff size, and merge state.',
  inputSchema: z.object({
    owner: z.string().describe('Repo owner, e.g. "bharath31"'),
    repo: z.string().describe('Repo name, e.g. "nominee-agent-testbed"'),
    number: z.number().describe('PR number'),
  }),
  async execute({ owner, repo, number }, { token }) {
    const pr = await brokerReadPR(token!, { owner, repo, number })
    return `PR #${pr.number} "${pr.title}" · +${pr.additions} −${pr.deletions} · ${pr.checks}`
  },
})
