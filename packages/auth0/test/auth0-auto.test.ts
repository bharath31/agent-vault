import { describe, expect, it, vi } from 'vitest'
import { MOCK_TTL_MS, auth0 } from '../src/index.js'

const realEnv = {
  AUTH0_DOMAIN: 'tenant.us.auth0.com',
  AUTH0_CLIENT_ID: 'cid',
  AUTH0_CLIENT_SECRET: 'secret',
  AUTH0_REFRESH_TOKEN: 'rt_123',
  AUTH0_USER_SUB: 'auth0|abc',
}

describe('auth0() — mock fallback', () => {
  it('returns the mock strategy when no Auth0 env is set', async () => {
    const s = auth0({ env: {} })
    expect(s.name).toBe('auth0-mock')
    const t = await s.getToken({ user: 'me', connection: 'github' })
    expect(t.token).toBe('mock-github-token-for-me')
    expect(t.expiresAt).toBeGreaterThan(Date.now())
    expect(t.expiresAt! - Date.now()).toBeLessThanOrEqual(MOCK_TTL_MS + 50)
  })

  it('mock strategy auto-approves', async () => {
    const s = auth0({ env: {} })
    const r = await s.requestApproval!({ user: 'me', action: 'github.merge_pr' })
    expect(r.decision).toBe('approved')
  })

  it('forces mock when mock:true even with full env', () => {
    expect(auth0({ mock: true, env: realEnv }).name).toBe('auth0-mock')
  })
})

describe('auth0() — real mode', () => {
  it('builds the real Auth0 strategy from env', async () => {
    const fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'gh_tok', expires_in: 3600, scope: 'repo' }),
      text: async () => '',
    })) as unknown as typeof globalThis.fetch
    const s = auth0({ env: realEnv, fetch })
    expect(s.name).toBe('auth0')
    expect(typeof s.requestApproval).toBe('function') // CIBA enabled via AUTH0_USER_SUB
    const t = await s.getToken({ user: 'me', connection: 'github' })
    expect(t.token).toBe('gh_tok')
  })
})

describe('auth0() — half-configured env', () => {
  it('throws an actionable error when only some Auth0 vars are set', () => {
    expect(() => auth0({ env: { AUTH0_DOMAIN: 'x.auth0.com' } })).toThrow(/AUTH0_CLIENT_ID/)
    expect(() => auth0({ env: { AUTH0_DOMAIN: 'x.auth0.com' } })).toThrow(/pnpm setup/)
  })

  it('throws when creds are present but the refresh token is missing', () => {
    const { AUTH0_REFRESH_TOKEN, ...noRt } = realEnv
    expect(() => auth0({ env: noRt })).toThrow(/AUTH0_REFRESH_TOKEN/)
  })
})
