import { nomineeTool } from 'nominee-eve'
import { z } from 'zod'
import { nominee } from '../../lib/nominee.js'

// Wrap an Eve tool so it draws its token and human approval from nominee.
// This allows an Eve agent to use Auth0 Token Vault, a generic OAuth store,
// or any nominee strategy instead of being tied to Vercel Connect.
export default nomineeTool({
  nominee,

  // Who the agent acts for. With Eve, you can often read this from ctx.session.
  user: (ctx) => ctx.session?.userId || 'alice',

  // Fetch a fresh token for 'github' before execute.
  connection: 'github',

  // Require human approval (via your nominee strategy) before running `execute`.
  approval: true,
  action: 'github.star',

  description: 'Star a GitHub repository',
  inputSchema: z.object({
    repo: z.string().describe('The repository name, e.g. vercel/ai'),
  }),

  async execute({ repo }, { token, eve }) {
    // `token` is a fresh GitHub token, auto-refreshed by nominee.
    // It is guaranteed to be fresh at the exact moment this tool runs,
    // regardless of how long the Eve agent was paused or durably executing.

    console.log(`[Eve Agent Tool] Executing github.star on ${repo}...`)
    console.log(`[Eve Agent Tool] Using token: ${token}`)

    // In a real app, you would make an API call to GitHub here:
    // await fetch(`https://api.github.com/user/starred/${repo}`, {
    //   method: 'PUT',
    //   headers: { Authorization: `Bearer ${token}` }
    // })

    return `Successfully starred ${repo}.`
  },
})
