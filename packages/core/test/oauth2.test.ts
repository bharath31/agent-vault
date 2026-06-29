import { describe, expect, it, vi } from 'vitest'
import { Nominee, OAuth2 } from '../src/index.js'

function mockFetch(response: unknown, ok = true, status = 200) {
  return vi.fn(async () => ({
    ok,
    status,
    json: async () => response,
    text: async () => JSON.stringify(response),
  })) as unknown as typeof fetch
}

describe('OAuth2 strategy', () => {
  it('exchanges a refresh token for a fresh access token', async () => {
    const fetch = mockFetch({ access_token: 'fresh_abc', expires_in: 3600, scope: 'repo read:org' })
    const strategy = OAuth2({
      fetch,
      connections: {
        github: {
          tokenEndpoint: 'https://example.com/token',
          clientId: 'cid',
          clientSecret: 'secret',
          refreshToken: 'rt_123',
        },
      },
    })

    const result = await strategy.getToken({ user: 'u1', connection: 'github' })
    expect(result.token).toBe('fresh_abc')
    expect(result.scopes).toEqual(['repo', 'read:org'])
    expect(result.expiresAt).toBeGreaterThan(Date.now())
  })

  it('resolves refresh tokens via a function (per-user store)', async () => {
    const fetch = mockFetch({ access_token: 'tok', expires_in: 60 })
    const refreshToken = vi.fn(async (p: { user: string }) => `rt_for_${p.user}`)
    const strategy = OAuth2({
      fetch,
      connections: {
        github: { tokenEndpoint: 'https://x/token', clientId: 'c', refreshToken },
      },
    })

    await strategy.getToken({ user: 'alice', connection: 'github' })
    expect(refreshToken).toHaveBeenCalledWith({ user: 'alice', connection: 'github' })
  })

  it('throws on unknown connection', async () => {
    const strategy = OAuth2({
      fetch: mockFetch({}),
      connections: { github: { tokenEndpoint: 'x', clientId: 'c', refreshToken: 'r' } },
    })
    await expect(strategy.getToken({ user: 'u', connection: 'slack' })).rejects.toThrow(
      /unknown connection/,
    )
  })

  it('throws on a non-ok token endpoint response', async () => {
    const strategy = OAuth2({
      fetch: mockFetch({ error: 'invalid_grant' }, false, 400),
      connections: { github: { tokenEndpoint: 'x', clientId: 'c', refreshToken: 'r' } },
    })
    await expect(strategy.getToken({ user: 'u', connection: 'github' })).rejects.toThrow(/400/)
  })

  it('works end-to-end through the Nominee engine with caching', async () => {
    const fetch = mockFetch({ access_token: 'tok', expires_in: 3600 })
    const n = new Nominee({
      strategy: OAuth2({
        fetch,
        connections: { github: { tokenEndpoint: 'x', clientId: 'c', refreshToken: 'r' } },
      }),
    })
    expect(await n.token({ user: 'u1', connection: 'github' })).toBe('tok')
    expect(await n.token({ user: 'u1', connection: 'github' })).toBe('tok')
    expect(fetch).toHaveBeenCalledTimes(1) // cached
  })
})

describe('OAuth2 refresh-token rotation', () => {
  it('persists the rotated refresh_token via onRefreshToken and uses it next cycle', async () => {
    // A mock token endpoint that ROTATES: each refresh invalidates the old
    // refresh token and issues a new one. This is what GitHub/Google/Okta do.
    const valid = new Set(['rt_seed'])
    let mintCount = 0
    const rotatingFetch = (async (_url: string, init: RequestInit) => {
      const sent = new URLSearchParams(init.body as string).get('refresh_token')!
      if (!valid.has(sent)) {
        return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })
      }
      valid.delete(sent) // rotate: old token is now dead
      const next = `rt_${++mintCount}`
      valid.add(next)
      return new Response(
        JSON.stringify({ access_token: `at_${mintCount}`, expires_in: 1, refresh_token: next }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof fetch

    // The caller's "store": a single mutable refresh token, written back on rotation.
    let stored = 'rt_seed'
    const strat = OAuth2({
      fetch: rotatingFetch,
      connections: {
        github: {
          tokenEndpoint: 'https://example.com/token',
          clientId: 'cid',
          refreshToken: () => stored,
          onRefreshToken: (_p, rt) => {
            stored = rt
          },
        },
      },
    })

    const a = await strat.getToken({ user: 'alice', connection: 'github' })
    expect(a.token).toBe('at_1')
    expect(stored).toBe('rt_1') // rotated token was persisted

    // Second cycle must use the rotated token, not the dead seed.
    const b = await strat.getToken({ user: 'alice', connection: 'github' })
    expect(b.token).toBe('at_2')
    expect(stored).toBe('rt_2')
  })
})
