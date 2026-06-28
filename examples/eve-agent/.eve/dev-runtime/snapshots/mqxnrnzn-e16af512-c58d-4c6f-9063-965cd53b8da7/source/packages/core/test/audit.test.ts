import { describe, expect, it, vi } from 'vitest'
import { Memory, Nominee } from '../src/index.js'
import type { AuditEvent } from '../src/index.js'

describe('audit events', () => {
  it('emits token.issued then token.cached with the agent identity', async () => {
    const events: AuditEvent[] = []
    const n = new Nominee({
      strategy: Memory({
        tokens: { u1: { github: { token: 't', expiresAt: Date.now() + 3_600_000 } } },
      }),
      agent: 'triage-bot',
      onAudit: (e) => events.push(e),
    })

    await n.token({ user: 'u1', connection: 'github' })
    await n.token({ user: 'u1', connection: 'github' })

    expect(events.map((e) => e.type)).toEqual(['token.issued', 'token.cached'])
    expect(events[0]).toMatchObject({ user: 'u1', connection: 'github', agent: 'triage-bot' })
    expect(events[0]?.chain).toEqual(['triage-bot'])
    expect(events[0]?.at).toBeTypeOf('number')
  })

  it('emits token.error on failure', async () => {
    const events: AuditEvent[] = []
    const n = new Nominee({ strategy: Memory(), onAudit: (e) => events.push(e) })
    await expect(n.token({ user: 'x', connection: 'y' })).rejects.toThrow()
    expect(events[0]?.type).toBe('token.error')
    expect(events[0]?.detail).toMatch(/no token/)
  })

  it('emits approval.requested and approval.resolved', async () => {
    const events: AuditEvent[] = []
    const n = new Nominee({
      strategy: Memory(),
      onAudit: (e) => events.push(e),
      onApprovalRequest: (req) => {
        n.resolveApproval(req.id, 'approved')
      },
    })
    await n.approve({ user: 'u1', action: 'close_issue' })
    expect(events.map((e) => e.type)).toEqual(['approval.requested', 'approval.resolved'])
    expect(events[1]?.decision).toBe('approved')
  })

  it('on() subscription can be removed', async () => {
    const fn = vi.fn()
    const n = new Nominee({
      strategy: Memory({ generate: () => ({ token: 't', expiresAt: Date.now() + 1000 }) }),
    })
    const off = n.on(fn)
    await n.token({ user: 'u', connection: 'c' })
    off()
    await n.token({ user: 'u', connection: 'c2' })
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('emits authz.checked when can() is supported', async () => {
    const events: AuditEvent[] = []
    const n = new Nominee({
      strategy: { name: 'fga', getToken: async () => ({ token: 't' }), can: async () => true },
      onAudit: (e) => events.push(e),
    })
    expect(await n.can({ user: 'u', action: 'read', resource: 'doc:1' })).toBe(true)
    expect(events[0]).toMatchObject({ type: 'authz.checked', decision: true, resource: 'doc:1' })
  })

  it('throws when can() is unsupported', async () => {
    const n = new Nominee({ strategy: Memory() })
    await expect(n.can({ user: 'u', action: 'read', resource: 'doc:1' })).rejects.toThrow(
      /does not implement can/,
    )
  })
})
