import { nomineeTool } from 'nominee-eve'
import { z } from 'zod'
import { nominee } from '../../lib/nominee.js'
import { mergePR } from '../../lib/github.js'

// The whole story: `connection` + `approval`. No token code, no refresh code.
// nominee gets human approval, then re-resolves a FRESH token at merge time —
// so the merge works no matter how long the approval pause was.
export default nomineeTool({
  nominee,
  user: 'me', // single-user demo; in a multi-user app, resolve from ctx.session
  connection: 'github',
  approval: true,
  action: 'github.merge_pr',
  description: 'Merge a pull request WITH nominee (fresh token + human approval).',
  inputSchema: z.object({
    owner: z.string(),
    repo: z.string(),
    number: z.number(),
  }),
  async execute({ owner, repo, number }, { token }) {
    const r = await mergePR({ owner, repo, number, token: token! })
    return `✓ Merged ${r.url}${r.simulated ? ' (simulated — mock mode)' : ''}`
  },
})
