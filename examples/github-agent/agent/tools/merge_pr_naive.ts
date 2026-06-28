import { defineTool } from 'eve/tools'
import { z } from 'zod'
import { APPROVAL_PAUSE_MS } from '../../lib/constants.js'
import { mergePR } from '../../lib/github.js'
import { captureToken } from '../../lib/naive-session.js'

// LEVEL 1 — WITHOUT nominee. The hand-rolled way: grab a token up front, wait for
// approval, then act with the token you grabbed. The pause is time-compressed to
// a few seconds (a real agent waits minutes or hours); by the time we merge, the
// captured token is stale → GitHub 401. This is the problem nominee removes.
export default defineTool({
  description: 'Merge a pull request WITHOUT nominee (hand-rolled token handling).',
  inputSchema: z.object({
    owner: z.string(),
    repo: z.string(),
    number: z.number(),
  }),
  async execute({ owner, repo, number }) {
    const raw = process.env.GITHUB_TOKEN
    if (!raw) return 'GITHUB_TOKEN not set — run `pnpm setup`.'

    const held = captureToken(raw) // grabbed up front, before the pause
    await new Promise((r) => setTimeout(r, APPROVAL_PAUSE_MS)) // the long wait (time-compressed)

    try {
      const r = await mergePR({
        owner,
        repo,
        number,
        token: held.token,
        capturedAtMs: held.capturedAtMs,
      })
      return `✓ Merged ${r.url}`
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      return `✗ ${message}\n(The token I grabbed went stale during the pause. This is what nominee fixes.)`
    }
  },
})
