import { describe, expect, it, vi } from 'vitest'
import { Memory, Nominee } from '../src/index.js'
import type { AuditEvent, Strategy } from '../src/index.js'

describe('Nominee.delegate', () => {
  it('records the full agent chain on a delegated action', async () => {
    const events: AuditEvent[] = []
    const orchestrator = new Nominee({
      strategy: Memory({ tokens: { u1: { github: 'tok' } } }),
      agent: 'orchestrator',
      onAudit: (e) => events.push(e),
    })
    const researcher = orchestrator.delegate('research-agent')

    await researcher.token({ user: 'u1', connection: 'github' })

    const issued = events.find((e) => e.type === 'token.issued')
    expect(issued?.chain).toEqual(['orchestrator', 'research-agent'])
    // the leaf — the identity that actually acted — is the sub-agent
    expect(issued?.agent).toBe('research-agent')
  })

  it('chains deeper through multiple delegations', async () => {
    const events: AuditEvent[] = []
    const root = new Nominee({
      strategy: Memory({ tokens: { u1: { slack: 'tok' } } }),
      agent: 'root',
      onAudit: (e) => events.push(e),
    })
    const child = root.delegate('planner').delegate('writer')

    await child.token({ user: 'u1', connection: 'slack' })

    expect(events.find((e) => e.type === 'token.issued')?.chain).toEqual([
      'root',
      'planner',
      'writer',
    ])
  })

  it('a sub-agent shares the parent cache (no refetch)', async () => {
    const getToken = vi.fn(async () => ({ token: 'tok', expiresAt: Date.now() + 3_600_000 }))
    const parent = new Nominee({ strategy: { name: 'x', getToken }, agent: 'parent' })

    await parent.token({ user: 'u1', connection: 'github' }) // fills the cache
    const sub = parent.delegate('sub')
    await sub.token({ user: 'u1', connection: 'github' }) // should hit the shared cache

    expect(getToken).toHaveBeenCalledTimes(1)
  })

  it('the parent chain is unchanged after delegating', async () => {
    const events: AuditEvent[] = []
    const parent = new Nominee({
      strategy: Memory({ tokens: { u1: { github: 'tok' } } }),
      agent: 'parent',
      onAudit: (e) => events.push(e),
    })
    parent.delegate('child') // must not mutate the parent's own chain

    await parent.token({ user: 'u1', connection: 'github' })
    expect(events.find((e) => e.type === 'token.issued')?.chain).toEqual(['parent'])
  })
})

describe('Nominee.exchange', () => {
  it('throws when the strategy does not support token exchange', async () => {
    const n = new Nominee({ strategy: Memory(), agent: 'a' })
    await expect(n.exchange({ user: 'u1', connection: 'github', actor: 'sub' })).rejects.toThrow(
      /does not implement exchange/,
    )
  })

  it('exchanges a downscoped token and emits token.exchanged with the chain', async () => {
    const events: AuditEvent[] = []
    const exchange = vi.fn(async () => ({ token: 'downscoped', expiresAt: Date.now() + 600_000 }))
    const strategy: Strategy = { name: 'rfc8693', getToken: async () => ({ token: 't' }), exchange }
    const n = new Nominee({ strategy, agent: 'orchestrator', onAudit: (e) => events.push(e) })

    const token = await n.exchange({
      user: 'u1',
      connection: 'github',
      actor: 'sub-agent',
      scopes: ['repo:read'],
    })

    expect(token).toBe('downscoped')
    expect(exchange).toHaveBeenCalledWith({
      user: 'u1',
      connection: 'github',
      actor: 'sub-agent',
      scopes: ['repo:read'],
    })
    const ev = events.find((e) => e.type === 'token.exchanged')
    expect(ev?.chain).toEqual(['orchestrator', 'sub-agent'])
  })
})
