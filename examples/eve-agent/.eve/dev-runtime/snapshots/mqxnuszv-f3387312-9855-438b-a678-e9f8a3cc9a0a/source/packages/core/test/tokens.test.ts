import { describe, expect, it, vi } from 'vitest'
import { Nominee, tokens } from '../src/index.js'

describe('install-and-go default path', () => {
  it('accepts a plain function as the strategy (no provider, no signup)', async () => {
    const nominee = new Nominee({
      strategy: ({ connection }) => `tok_for_${connection}`,
    })
    expect(await nominee.token({ user: 'u1', connection: 'github' })).toBe('tok_for_github')
  })

  it('accepts an async function returning a TokenResult', async () => {
    const nominee = new Nominee({
      strategy: async ({ connection }) => ({
        token: `t_${connection}`,
        expiresAt: Date.now() + 3_600_000,
      }),
    })
    expect(await nominee.token({ user: 'u1', connection: 'slack' })).toBe('t_slack')
  })

  it('reads from environment variables in one line', async () => {
    process.env.GITHUB_TOKEN = 'ghp_from_env'
    const nominee = new Nominee({
      strategy: ({ connection }) => process.env[`${connection.toUpperCase()}_TOKEN`] ?? '',
    })
    expect(await nominee.token({ user: 'u1', connection: 'github' })).toBe('ghp_from_env')
    process.env.GITHUB_TOKEN = undefined
  })

  it('tokens() names the strategy and normalizes string returns', async () => {
    const strategy = tokens(() => 'plain')
    expect(strategy.name).toBe('tokens')
    expect(await strategy.getToken({ user: 'u', connection: 'c' })).toEqual({ token: 'plain' })
  })

  it('caches when the resolver returns an expiry', async () => {
    const resolver = vi.fn(() => ({ token: 't', expiresAt: Date.now() + 3_600_000 }))
    const nominee = new Nominee({ strategy: resolver })
    await nominee.token({ user: 'u1', connection: 'github' })
    await nominee.token({ user: 'u1', connection: 'github' })
    expect(resolver).toHaveBeenCalledTimes(1)
  })
})
