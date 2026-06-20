import type { ApprovalParams, ApprovalResult, GetTokenParams, Strategy, TokenResult } from 'nominee'

const FEDERATED_GRANT =
  'urn:auth0:params:oauth:grant-type:token-exchange:federated-connection-access-token'
const FEDERATED_REQUESTED_TOKEN =
  'http://auth0.com/oauth/token-type/federated-connection-access-token'
const SUBJECT_REFRESH = 'urn:ietf:params:oauth:token-type:refresh_token'
const SUBJECT_ACCESS = 'urn:ietf:params:oauth:token-type:access_token'
const CIBA_GRANT = 'urn:openid:params:grant-type:ciba'

export interface Auth0CibaOptions {
  /**
   * Map a nominee user id to an Auth0 `login_hint` (typically the user's `sub`).
   * Defaults to the user id verbatim.
   */
  loginHint?: (user: string) => string | Promise<string>
  /**
   * Short message shown to the user on their device when approving. Auth0
   * limits this to ~64 chars. Defaults to `Approve: <action>`.
   */
  bindingMessage?: (params: ApprovalParams) => string | Promise<string>
  /** Scope requested for the approval. Default `"openid"`. */
  scope?: string
  /** API audience for the approval token, if your tenant requires one. */
  audience?: string
  /** Override the server-provided poll interval (ms). */
  pollIntervalMs?: number
}

export interface Auth0Options {
  /** Your Auth0 tenant domain, e.g. `your-tenant.us.auth0.com`. */
  domain: string
  clientId: string
  clientSecret: string
  /**
   * Resolve the user's Auth0 token used as the token-exchange subject — read it
   * from your session store. Return the user's **refresh token** (recommended,
   * durable) or access token (set {@link subjectTokenType} to `"access_token"`).
   */
  subjectToken: (params: GetTokenParams) => string | Promise<string>
  /** Type of the subject token. Default `"refresh_token"`. */
  subjectTokenType?: 'refresh_token' | 'access_token'
  /**
   * Enable human-in-the-loop approval via CIBA (push/SMS to the user's device).
   * Omit to disable native approval — nominee then falls back to its built-in
   * approval engine.
   */
  ciba?: Auth0CibaOptions
  /** Custom fetch implementation (defaults to global `fetch`). Useful for tests. */
  fetch?: typeof fetch
}

interface TokenResponse {
  access_token: string
  expires_in?: number
  scope?: string
}

interface BcAuthorizeResponse {
  auth_req_id: string
  expires_in?: number
  interval?: number
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms)
    t.unref?.()
  })

/**
 * Auth0 strategy for nominee — the flagship, most complete strategy.
 *
 * - `getToken` brokers a fresh third-party token via **Auth0 Token Vault**
 *   (federated-connection token exchange), so your agent acts on the user's
 *   GitHub / Slack / Google / … without you ever touching those credentials.
 * - `requestApproval` runs **CIBA** human-in-the-loop: the user approves on
 *   their phone, then the agent resumes.
 *
 * Works with any nominee adapter (`nominee-ai`, `nominee-eve`) or standalone.
 *
 * ```ts
 * import { Nominee } from 'nominee'
 * import { Auth0 } from 'nominee-auth0'
 *
 * const nominee = new Nominee({
 *   strategy: Auth0({
 *     domain: process.env.AUTH0_DOMAIN!,
 *     clientId: process.env.AUTH0_CLIENT_ID!,
 *     clientSecret: process.env.AUTH0_CLIENT_SECRET!,
 *     subjectToken: ({ user }) => store.getRefreshToken(user), // your session store
 *     ciba: { loginHint: (user) => store.getAuth0Sub(user) },
 *   }),
 * })
 *
 * const token = await nominee.token({ user, connection: 'github' }) // always fresh
 * ```
 */
export function Auth0(options: Auth0Options): Strategy {
  const doFetch = options.fetch ?? globalThis.fetch
  if (typeof doFetch !== 'function') {
    throw new Error('nominee-auth0: no global fetch available; pass options.fetch')
  }
  const base = `https://${options.domain}`
  const subjectTokenType =
    options.subjectTokenType === 'access_token' ? SUBJECT_ACCESS : SUBJECT_REFRESH

  async function getToken(params: GetTokenParams): Promise<TokenResult> {
    const subjectToken = await options.subjectToken(params)
    const body = {
      grant_type: FEDERATED_GRANT,
      subject_token_type: subjectTokenType,
      subject_token: subjectToken,
      requested_token_type: FEDERATED_REQUESTED_TOKEN,
      connection: params.connection,
      client_id: options.clientId,
      client_secret: options.clientSecret,
      ...(params.scopes?.length ? { scope: params.scopes.join(' ') } : {}),
    }

    const res = await doFetch(`${base}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(
        `nominee-auth0: Token Vault exchange for connection "${params.connection}" failed (${res.status}) ${text}`.trim(),
      )
    }

    const json = (await res.json()) as TokenResponse
    const result: TokenResult = { token: json.access_token }
    if (typeof json.expires_in === 'number') result.expiresAt = Date.now() + json.expires_in * 1000
    if (json.scope) result.scopes = json.scope.split(' ')
    return result
  }

  async function requestApproval(params: ApprovalParams): Promise<ApprovalResult> {
    const ciba = options.ciba
    if (!ciba) {
      throw new Error(
        'nominee-auth0: approval requested but CIBA is not configured. Add `ciba` to Auth0() options, or remove `approval` from the tool.',
      )
    }

    const loginHint = ciba.loginHint ? await ciba.loginHint(params.user) : params.user
    const bindingMessage = ciba.bindingMessage
      ? await ciba.bindingMessage(params)
      : `Approve: ${params.action}`

    // 1. Backchannel authorization request.
    const authBody = new URLSearchParams({
      client_id: options.clientId,
      client_secret: options.clientSecret,
      scope: ciba.scope ?? 'openid',
      login_hint: loginHint,
      binding_message: bindingMessage,
    })
    if (ciba.audience) authBody.set('audience', ciba.audience)

    const authRes = await doFetch(`${base}/bc-authorize`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: authBody,
    })
    if (!authRes.ok) {
      const text = await authRes.text().catch(() => '')
      throw new Error(`nominee-auth0: CIBA bc-authorize failed (${authRes.status}) ${text}`.trim())
    }
    const auth = (await authRes.json()) as BcAuthorizeResponse
    const id = auth.auth_req_id

    // 2. Poll the token endpoint until the user decides (or it expires).
    const pollMs = ciba.pollIntervalMs ?? (auth.interval ?? 5) * 1000
    const ttlMs = params.timeoutMs ?? (auth.expires_in ?? 300) * 1000
    const deadline = Date.now() + ttlMs

    while (Date.now() < deadline) {
      await sleep(pollMs)
      const pollRes = await doFetch(`${base}/oauth/token`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: new URLSearchParams({
          grant_type: CIBA_GRANT,
          auth_req_id: id,
          client_id: options.clientId,
          client_secret: options.clientSecret,
        }),
      })

      if (pollRes.ok) return { id, decision: 'approved' }

      const err = (await pollRes.json().catch(() => ({}))) as { error?: string }
      if (err.error === 'authorization_pending' || err.error === 'slow_down') continue
      if (err.error === 'access_denied') return { id, decision: 'denied' }
      if (err.error === 'expired_token') return { id, decision: 'expired' }
      throw new Error(
        `nominee-auth0: CIBA poll failed (${pollRes.status}) ${err.error ?? ''}`.trim(),
      )
    }

    return { id, decision: 'expired' }
  }

  const strategy: Strategy = { name: 'auth0', getToken }
  if (options.ciba) strategy.requestApproval = requestApproval
  return strategy
}
