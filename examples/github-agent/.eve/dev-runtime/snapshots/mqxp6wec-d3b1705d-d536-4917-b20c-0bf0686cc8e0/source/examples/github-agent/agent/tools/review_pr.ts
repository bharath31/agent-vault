import { nomineeTool } from 'nominee-eve'
import { z } from 'zod'
import { nominee } from '../../lib/nominee.js'
import { getPR } from '../../lib/github.js'

export default nomineeTool({
  nominee,
  user: 'me', // single-user demo; in a multi-user app, resolve from ctx.session
  connection: 'github', // nominee fetches a fresh token at call time
  action: 'github.review_pr',
  description: 'Read a pull request: title, diff size, and CI status.',
  inputSchema: z.object({
    owner: z.string().describe('Repo owner, e.g. "octocat"'),
    repo: z.string().describe('Repo name, e.g. "hello-world"'),
    number: z.number().describe('PR number'),
  }),
  async execute({ owner, repo, number }, { token }) {
    const pr = await getPR({ owner, repo, number, token: token! })
    return `PR #${pr.number} "${pr.title}" · +${pr.additions} −${pr.deletions} · checks ${pr.checks}`
  },
})
