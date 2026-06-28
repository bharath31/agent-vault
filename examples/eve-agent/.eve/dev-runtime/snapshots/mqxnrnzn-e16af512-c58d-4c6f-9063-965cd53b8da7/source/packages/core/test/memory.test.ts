import { describe, expect, it } from 'vitest'
import { Memory } from '../src/index.js'

describe('Memory strategy', () => {
  it('returns seeded string tokens', async () => {
    const s = Memory({ tokens: { u1: { github: 'tok_gh' } } })
    expect((await s.getToken({ user: 'u1', connection: 'github' })).token).toBe('tok_gh')
  })

  it('returns seeded TokenResult tokens', async () => {
    const s = Memory({
      tokens: { u1: { github: { token: 'tok', expiresAt: 123, scopes: ['a'] } } },
    })
    expect(await s.getToken({ user: 'u1', connection: 'github' })).toEqual({
      token: 'tok',
      expiresAt: 123,
      scopes: ['a'],
    })
  })

  it('generates on demand when configured', async () => {
    const s = Memory({ generate: (p) => `gen_${p.user}_${p.connection}` })
    expect((await s.getToken({ user: 'u1', connection: 'slack' })).token).toBe('gen_u1_slack')
  })

  it('supports runtime set()', async () => {
    const s = Memory()
    s.set('u1', 'github', 'late_token')
    expect((await s.getToken({ user: 'u1', connection: 'github' })).token).toBe('late_token')
  })

  it('throws when nothing matches and no generator', async () => {
    const s = Memory()
    await expect(s.getToken({ user: 'u', connection: 'x' })).rejects.toThrow(/no token/)
  })
})
