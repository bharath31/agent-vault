import { always } from 'eve/tools/approval'
import { nomineeTool } from 'nominee-eve'
import { z } from 'zod'
import { brokerMerge } from '../../lib/broker.js'
import { nominee } from '../../lib/nominee.js'

// WITH nominee. nominee requests FRESH merge access at merge time, so the access
// is valid right now no matter how long the approval pause was. You approve right
// here in the chat (Eve's native human-in-the-loop). The developer writes only
// `connection: 'github'` + `needsApproval` — no token plumbing.
export default nomineeTool({
  nominee,
  user: 'me',
  connection: 'github',
  needsApproval: always(),
  action: 'github.merge_pr_with_nominee',
  description: 'Merge a pull request with nominee (fresh access + your approval).',
  inputSchema: z.object({
    owner: z.string(),
    repo: z.string(),
    number: z.number(),
  }),
  async execute({ owner, repo, number }, { token }) {
    const r = await brokerMerge(token!, { owner, repo, number })
    return `✓ Merged ${r.url}`
  },
})
