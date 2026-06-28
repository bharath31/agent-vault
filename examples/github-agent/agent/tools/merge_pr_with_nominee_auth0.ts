import { nomineeTool } from 'nominee-eve'
import { z } from 'zod'
import { mergePR } from '../../lib/github.js'
import { nomineeAuth0 } from '../../lib/nominee-auth0.js'

// WITH nominee + Auth0. The token comes from Auth0 Token Vault and the approval
// is a CIBA push to your phone. Requires an Auth0 tenant with Token Vault + CIBA
// (see README). Same tool shape as merge_pr_with_nominee — only the nominee
// instance differs (`auth0()` instead of the gh-token strategy).
export default nomineeTool({
  nominee: nomineeAuth0,
  user: () => {
    if (!process.env.AUTH0_DOMAIN) {
      throw new Error(
        'Auth0 not configured. Sign up at https://auth0.com (you need Token Vault + CIBA), then run `pnpm setup:auth0`.',
      )
    }
    return process.env.AUTH0_USER_SUB ?? 'me'
  },
  connection: 'github',
  approval: true, // nominee CIBA — pushes an approval to your phone
  action: 'github.merge_pr_with_nominee_auth0',
  description:
    'Merge a pull request using Auth0 Token Vault + CIBA. ONLY use when the user explicitly says "auth0" or "token vault" — not for a plain "with nominee" request.',
  inputSchema: z.object({
    owner: z.string(),
    repo: z.string(),
    number: z.number(),
  }),
  async execute({ owner, repo, number }, { token }) {
    const r = await mergePR({ owner, repo, number, token: token! })
    return `✓ Merged ${r.url} (Auth0 Token Vault + CIBA)`
  },
})
