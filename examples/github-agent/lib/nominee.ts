import { Nominee } from 'nominee'

// LEVEL 2 — with nominee (works for everybody).
//
// nominee re-resolves a real GitHub token at the *moment of the tool call*,
// never capturing one up front. `pnpm setup` writes GITHUB_TOKEN (from
// `gh auth token`) into .env.local; the strategy reads it fresh on every call.
export const nominee = new Nominee({
  strategy: ({ connection }) => {
    const token = process.env.GITHUB_TOKEN
    if (!token) {
      throw new Error(
        `nominee: GITHUB_TOKEN is not set (needed for "${connection}"). Run \`pnpm setup\`.`,
      )
    }
    return token
  },
  agent: 'github-agent',
})
