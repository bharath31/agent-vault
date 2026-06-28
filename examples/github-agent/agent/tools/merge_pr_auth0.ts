import { nomineeTool } from 'nominee-eve'
import { z } from 'zod'
import { mergePR } from '../../lib/github.js'
import { nomineeAuth0 } from '../../lib/nominee-auth0.js'

// LEVEL 3 — WITH nominee + Auth0. The token comes from Auth0 Token Vault and the
// approval is a CIBA push to your phone. Requires an Auth0 tenant with Token
// Vault + CIBA (see README). Same tool shape as Level 2 — only the nominee
// instance differs (`auth0()` instead of the gh-token strategy).
export default nomineeTool({
  nominee: nomineeAuth0,
  user: () => {
    if (!process.env.AUTH0_DOMAIN) {
      throw new Error(
        'Auth0 not configured. Sign up at https://auth0.com (you need Token Vault + CIBA), then run `pnpm setup --auth0`.',
      )
    }
    return process.env.AUTH0_USER_SUB ?? 'me'
  },
  connection: 'github',
  approval: true, // nominee CIBA — pushes an approval to your phone
  action: 'github.merge_pr_auth0',
  description:
    'Merge a pull request WITH nominee + Auth0 (Token Vault token + CIBA phone approval).',
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
