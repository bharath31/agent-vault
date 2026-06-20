import { Nominee, tokens } from 'nominee'

async function main() {
  console.log('--- Nominee Standalone Node Example ---\n')

  let pendingApprovalId: string | undefined

  // 1. Initialize Nominee with a simple function strategy.
  const nominee = new Nominee({
    strategy: tokens(async ({ connection, user }) => {
      console.log(`[Strategy] Generating fresh token for ${user} on ${connection}...`)
      // Return a mock token with an expiry for this demo so it gets cached
      return {
        token: `mock-${connection}-token-${Date.now()}`,
        expiresAt: Date.now() + 1000 * 60 * 60, // 1 hour
      }
    }),

    // Triggered when an agent requires approval for a sensitive action
    onApprovalRequest: async (req) => {
      console.log(`\n[Approval Required] Action: ${req.action}`)
      console.log(`Detail: ${req.detail}`)
      console.log(`Approval ID: ${req.id}`)
      pendingApprovalId = req.id
    },

    // Global audit sink for all events
    onAudit: (event) => {
      const what = event.action ?? event.connection ?? ''
      const outcome = event.decision !== undefined ? ` ${event.decision}` : ''
      console.log(`[Audit] ${event.type} ${what}${outcome} · agent=${event.agent ?? 'N/A'}`)
    },

    agent: 'example-bot',
  })

  const user = 'alice'
  const connection = 'github'

  console.log('1. Requesting token...')
  const token1 = await nominee.token({ user, connection })
  console.log(`Token received: ${token1}\n`)

  console.log('2. Requesting token again (should be cached)...')
  const token2 = await nominee.token({ user, connection })
  console.log(`Token received: ${token2}\n`)

  console.log('Are tokens identical?', token1 === token2)

  // 3. Example of an approval flow
  console.log('\n--- Approval Example ---')
  console.log('An agent wants to delete a repository. We need human approval.')

  // Create an approval request. This returns a Promise that resolves when approved.
  const approvalPromise = nominee.approve({
    user,
    action: 'repo.delete',
    detail: 'Delete repo: alice/old-project',
  })

  // We wait a bit to simulate a user receiving a Slack notification,
  // reviewing the detail, and then clicking 'Approve'.
  setTimeout(() => {
    if (pendingApprovalId) {
      console.log('\n[Webhook] Simulating user clicking "Approve" in dashboard...')
      nominee.resolveApproval(pendingApprovalId, 'approved')
    }
  }, 1000)

  try {
    // Wait for the human to approve or deny
    await approvalPromise
    console.log('\n[Agent] Approval granted! Proceeding with action...')
  } catch (err: any) {
    console.log(`\n[Agent] Approval failed: ${err.message}`)
  }
}

main().catch(console.error)
