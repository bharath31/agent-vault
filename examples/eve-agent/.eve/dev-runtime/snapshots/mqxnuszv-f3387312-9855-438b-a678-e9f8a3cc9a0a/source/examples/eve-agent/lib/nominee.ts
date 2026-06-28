import { Nominee, tokens } from 'nominee'

export const nominee = new Nominee({
  strategy: tokens(async ({ connection, user }) => {
    // Return a mock token for this demo
    return {
      token: `mock-${connection}-token-for-${user}`,
      expiresAt: Date.now() + 3600 * 1000,
    }
  }),
  onApprovalRequest: (req) => {
    console.log(`\n[Nominee Approval Required] Action: ${req.action}`)
    console.log(`Approval ID: ${req.id}`)
    // Simulate user approving via dashboard after 2s
    setTimeout(() => {
      console.log('[Webhook] Simulating external approval...')
      nominee.resolveApproval(req.id, 'approved')
    }, 2000)
  },
  onAudit: (e) => {
    console.log(`[Audit] ${e.type} | ${e.action ?? e.connection ?? ''} ${e.decision ?? ''}`.trim())
  },
  agent: 'eve-demo-agent',
})
