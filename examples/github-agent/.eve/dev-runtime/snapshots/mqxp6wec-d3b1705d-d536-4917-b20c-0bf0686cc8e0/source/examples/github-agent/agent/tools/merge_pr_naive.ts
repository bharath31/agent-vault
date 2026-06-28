import { defineTool } from 'eve/tools'
import { z } from 'zod'
import { nominee } from '../../lib/nominee.js'
import { mergePR } from '../../lib/github.js'
import { captureToken } from '../../lib/naive-session.js'
import { APPROVAL_PAUSE_MS } from '../../lib/constants.js'

// The hand-rolled way, WITHOUT nominee. This is what a careful developer writes:
// grab a token, wait for approval, then act. It looks fine — and it breaks,
// because the token grabbed up front goes stale during the pause.
export default defineTool({
  description: 'Merge a pull request WITHOUT nominee (hand-rolled token handling).',
  inputSchema: z.object({
    owner: z.string(),
    repo: z.string(),
    number: z.number(),
  }),
  async execute({ owner, repo, number }) {
    const user = 'me'

    // 1. Grab a GitHub token up front, the way a long-running agent would.
    const raw = await nominee.token({ user, connection: 'github' })
    const held = captureToken(raw) // token grabbed before the pause — still valid? we assume so…

    // 2. Pause for human approval (the agent's long wait).
    await new Promise((r) => setTimeout(r, APPROVAL_PAUSE_MS))

    // 3. Act with the token we grabbed earlier. If it expired, now what —
    //    refresh? re-auth? This is the bookkeeping nominee removes.
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
      return `✗ ${message}\n(The captured token went stale during the pause. This is the problem nominee solves.)`
    }
  },
})
