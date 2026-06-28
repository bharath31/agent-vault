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
