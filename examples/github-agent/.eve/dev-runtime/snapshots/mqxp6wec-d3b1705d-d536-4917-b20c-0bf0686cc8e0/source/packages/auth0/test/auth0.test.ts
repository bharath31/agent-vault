import { Nominee } from 'nominee'
import { describe, expect, it, vi } from 'vitest'
import { Auth0 } from '../src/index.js'

interface MockCall {
  url: string
  body: string
}

/**
 * Routes Auth0 endpoints: the Token Vault exchange (`/oauth/token` with the
 * federated grant), CIBA `/bc-authorize`, and the CIBA poll (`/oauth/token`
 * with the ciba grant). `pollResults` is consumed one entry per poll.
 */
function mockAuth0(opts: {
  tokenVault?: unknown
  bcAuthorize?: unknown
  pollResults?: Array<{ ok: boolean; body: unknown }>
}) {
  const calls: MockCall[] = []
  let pollIndex = 0
  const fetch = vi.fn(async (url: string, init: { body: unknown }) => {
    const body = String(init.body)
    calls.push({ url, body })
    const ok = (data: unknown) => ({
      ok: true,
      status: 200,
      json: async () => data,
      text: async () => JSON.stringify(data),
    })
    const fail = (status: number, data: unknown) => ({
      ok: false,
      status,
      json: async () => data,
      text: async () => JSON.stringify(data),
    })

    if (url.endsWith('/bc-authorize')) return ok(opts.bcAuthorize)
    if (url.endsWith('/oauth/token') && body.includes('grant-type%3Aciba')) {
      const r = opts.pollResults?.[pollIndex++] ?? { ok: false, body: { error: 'expired_token' } }
      return r.ok ? ok(r.body) : fail(403, r.body)
    }
    if (url.endsWith('/oauth/token')) return ok(opts.tokenVault)
    return fail(404, { error: 'not_found' })
  }) as unknown as typeof globalThis.fetch

  return { fetch, calls: () => calls }
}

describe('nominee-auth0 — Token Vault', () => {
  it('exchanges the subject token for a federated connection token', async () => {
    const { fetch, calls } = mockAuth0({
      tokenVault: { access_token: 'gh_federated', expires_in: 3600, scope: 'repo' },
    })
    const nominee = new Nominee({
      strategy: Auth0({
        domain: 'tenant.us.auth0.com',
        clientId: 'cid',
        clientSecret: 'secret',
        subjectToken: () => 'user_refresh_token',
        fetch,
      }),
    })

    const token = await nominee.token({ user: 'u1', connection: 'github' })
    expect(token).toBe('gh_federated')

    const exchange = calls()[0]!
    expect(exchange.url).toBe('https://tenant.us.auth0.com/oauth/token')
    const parsed = JSON.parse(exchange.body)
    expect(parsed.grant_type).toContain('federated-connection-access-token')
    expect(parsed.connection).toBe('github')
    expect(parsed.subject_token).toBe('user_refresh_token')
    expect(parsed.subject_token_type).toContain('refresh_token')
  })

  it('throws a clear error when the exchange fails', async () => {
    const { fetch } = mockAuth0({})
    const strategy = Auth0({
      domain: 't.auth0.com',
      clientId: 'c',
      clientSecret: 's',
      subjectToken: () => 'rt',
      fetch,
    })
    // tokenVault undefined -> ok(undefined) returns { access_token: undefined }; force failure path instead:
    const failing = Auth0({
      domain: 't.auth0.com',
      clientId: 'c',
      clientSecret: 's',
      subjectToken: () => 'rt',
      fetch: vi.fn(async () => ({
        ok: false,
        status: 403,
        text: async () => 'forbidden',
        json: async () => ({}),
      })) as never,
    })
    await expect(failing.getToken({ user: 'u', connection: 'github' })).rejects.toThrow(
      /Token Vault exchange.*github.*403/,
    )
    expect(strategy.name).toBe('auth0')
  })
})

describe('nominee-auth0 — CIBA approval', () => {
  it('returns approved after polling through authorization_pending', async () => {
    const { fetch } = mockAuth0({
      bcAuthorize: { auth_req_id: 'req_1', interval: 0, expires_in: 300 },
      pollResults: [
        { ok: false, body: { error: 'authorization_pending' } },
        { ok: true, body: { access_token: 'approved_tok' } },
      ],
    })
    const strategy = Auth0({
      domain: 't.auth0.com',
      clientId: 'c',
      clientSecret: 's',
      subjectToken: () => 'rt',
      ciba: { pollIntervalMs: 1 },
      fetch,
    })
    const result = await strategy.requestApproval!({ user: 'u1', action: 'close_issue' })
    expect(result.decision).toBe('approved')
    expect(result.id).toBe('req_1')
  })

  it('returns denied on access_denied', async () => {
    const { fetch } = mockAuth0({
      bcAuthorize: { auth_req_id: 'req_2', interval: 0, expires_in: 300 },
      pollResults: [{ ok: false, body: { error: 'access_denied' } }],
    })
    const strategy = Auth0({
      domain: 't.auth0.com',
      clientId: 'c',
      clientSecret: 's',
      subjectToken: () => 'rt',
      ciba: { pollIntervalMs: 1 },
      fetch,
    })
    const result = await strategy.requestApproval!({ user: 'u1', action: 'delete' })
    expect(result.decision).toBe('denied')
  })

  it('omits requestApproval when ciba is not configured', () => {
    const strategy = Auth0({
      domain: 't.auth0.com',
      clientId: 'c',
      clientSecret: 's',
      subjectToken: () => 'rt',
    })
    expect(strategy.requestApproval).toBeUndefined()
  })

  it('integrates with nominee.approve end-to-end', async () => {
    const { fetch } = mockAuth0({
      bcAuthorize: { auth_req_id: 'req_3', interval: 0, expires_in: 300 },
      pollResults: [{ ok: true, body: { access_token: 'ok' } }],
    })
    const nominee = new Nominee({
      strategy: Auth0({
        domain: 't.auth0.com',
        clientId: 'c',
        clientSecret: 's',
        subjectToken: () => 'rt',
        ciba: { pollIntervalMs: 1, loginHint: (u) => `auth0|${u}` },
        fetch,
      }),
    })
    await expect(nominee.approve({ user: 'u1', action: 'wire_money' })).resolves.toMatchObject({
      decision: 'approved',
    })
  })
})
