import type { GetTokenParams, Strategy, TokenResult } from '../strategy.js'

export interface OAuth2Connection {
  /** The OAuth2 token endpoint, e.g. `https://github.com/login/oauth/access_token`. */
  tokenEndpoint: string
  clientId: string
  clientSecret?: string
  /**
   * The stored refresh token for this connection, or a function that resolves
   * it per (user, connection). This is where you read from your own token store.
   */
  refreshToken: string | ((params: GetTokenParams) => string | Promise<string>)
}

export interface OAuth2Options {
  /** Per-connection config, keyed by connection name (e.g. `"github"`). */
  connections: Record<string, OAuth2Connection>
  /** Custom fetch implementation (defaults to global `fetch`). Useful for tests. */
  fetch?: typeof fetch
}

interface TokenEndpointResponse {
  access_token: string
  expires_in?: number
  scope?: string
  refresh_token?: string
}

/**
 * Generic OAuth2 refresh-token strategy. Zero dependencies. Works with any
 * provider that supports the `refresh_token` grant — so nominee is useful with
 * *no* identity vendor at all: you bring your own stored refresh tokens and
 * this keeps access tokens fresh.
 */
export function OAuth2(options: OAuth2Options): Strategy {
  const doFetch = options.fetch ?? globalThis.fetch
  if (typeof doFetch !== 'function') {
    throw new Error('nominee(oauth2): no global fetch available; pass options.fetch')
  }

  return {
    name: 'oauth2',
    async getToken(params) {
      const conn = options.connections[params.connection]
      if (!conn) {
        throw new Error(`nominee(oauth2): unknown connection "${params.connection}"`)
      }

      const refreshToken =
        typeof conn.refreshToken === 'function'
          ? await conn.refreshToken(params)
          : conn.refreshToken

      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: conn.clientId,
      })
      if (conn.clientSecret) body.set('client_secret', conn.clientSecret)
      if (params.scopes?.length) body.set('scope', params.scopes.join(' '))

      const res = await doFetch(conn.tokenEndpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body,
      })

      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`nominee(oauth2): token endpoint returned ${res.status} ${text}`.trim())
      }

      const json = (await res.json()) as TokenEndpointResponse
      const result: TokenResult = { token: json.access_token }
      if (typeof json.expires_in === 'number') {
        result.expiresAt = Date.now() + json.expires_in * 1000
      }
      if (json.scope) result.scopes = json.scope.split(' ')
      return result
    },
  }
}
