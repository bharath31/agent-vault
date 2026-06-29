import { defineTool } from 'eve/tools'
import { z } from 'zod'
import { BrokerError, brokerMerge, requestAccess } from '../../lib/broker.js'
import { APPROVAL_PAUSE_MS } from '../../lib/constants.js'

// The plain "merge a PR" tool — the natural-but-wrong first attempt. It grabs
// merge access up front, waits for approval, then merges with the access it
// grabbed. But just-in-time access is short-lived (by design), so by the time
// the agent acts, the broker has genuinely expired it → the merge is rejected
// (real HTTP 403, not a simulation). It's the same class of bug as a stale
// OAuth token across a pause — see examples/token-refresh-correctness for the
// general case (expiry + rotation + concurrency). merge_pr_with_nominee fixes it
// by resolving access at call time instead.
export default defineTool({
  description: 'Merge a pull request (the plain, hand-rolled way).',
  inputSchema: z.object({
    owner: z.string(),
    repo: z.string(),
    number: z.number(),
  }),
  async execute({ owner, repo, number }) {
    const access = await requestAccess() // grabbed up front, before the pause
    await new Promise((r) => setTimeout(r, APPROVAL_PAUSE_MS)) // the long approval wait

    try {
      const r = await brokerMerge(access.token, { owner, repo, number })
      return `✓ Merged ${r.url}`
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      // Only blame token expiry when that's actually what happened — a merge
      // conflict / already-merged PR / branch protection is a different failure.
      const expired = e instanceof BrokerError && e.expired
      return expired
        ? `✗ ${message}\n(The access I grabbed expired during the pause — the staleness nominee handles by resolving at call time.)`
        : `✗ ${message}`
    }
  },
})
