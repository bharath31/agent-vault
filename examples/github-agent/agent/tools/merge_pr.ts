import { defineTool } from 'eve/tools'
import { z } from 'zod'
import { APPROVAL_PAUSE_MS } from '../../lib/constants.js'
import { mergePR } from '../../lib/github.js'
import { captureToken } from '../../lib/naive-session.js'

// The plain "merge a PR" tool — the hand-rolled way most people write first.
// It grabs a token up front, waits for approval, then acts with the token it
// grabbed.
//
// ⚠️  SIMULATED EXPIRY: a real GitHub token lives ~1 hour, and we can't make a
// demo wait an hour for it to actually expire. So we COMPRESS TIME — the pause
// is a few seconds and the captured token is *treated* as expired after
// DEMO_TTL_MS. The resulting "401" is thrown by our own code (see lib/github.ts),
// not returned by GitHub; the real token is still valid. It stands in for the
// failure that would genuinely happen an hour into a paused agent session.
// This is the problem nominee removes (see merge_pr_with_nominee).
export default defineTool({
  description: 'Merge a pull request (the plain, hand-rolled way).',
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
