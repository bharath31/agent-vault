import { always } from 'eve/tools/approval'
import { nomineeTool } from 'nominee-eve'
import { z } from 'zod'
import { mergePR } from '../../lib/github.js'
import { nominee } from '../../lib/nominee.js'

// LEVEL 2 — WITH nominee. nominee re-resolves a FRESH token at merge time, so the
// merge works no matter how long the approval pause was. You approve right here
// in the chat (Eve's native human-in-the-loop). The developer writes only
// `connection: 'github'` + `needsApproval` — no token or refresh code.
export default nomineeTool({
  nominee,
  user: 'me',
  connection: 'github',
  needsApproval: always(),
  action: 'github.merge_pr',
  description: 'Merge a pull request WITH nominee (fresh token + your approval).',
  inputSchema: z.object({
    owner: z.string(),
    repo: z.string(),
    number: z.number(),
  }),
  async execute({ owner, repo, number }, { token }) {
    const r = await mergePR({ owner, repo, number, token: token! })
    return `✓ Merged ${r.url}`
  },
})
