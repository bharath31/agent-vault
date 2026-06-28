import type { GetTokenParams, Strategy, TokenResult } from '../strategy.js'

export interface MemoryOptions {
  /** Seed tokens: `{ [user]: { [connection]: token | TokenResult } }`. */
  tokens?: Record<string, Record<string, string | TokenResult>>
  /** Generate a token on demand when one isn't seeded. */
  generate?: (params: GetTokenParams) => string | TokenResult
}

export interface MemoryStrategy extends Strategy {
  /** Set/replace a token for a user+connection at runtime (handy in tests). */
  set(user: string, connection: string, token: string | TokenResult): void
}

const normalize = (t: string | TokenResult): TokenResult =>
  typeof t === 'string' ? { token: t } : t

/**
 * In-memory strategy for local development and tests. No network, no provider.
 * Useful to wire up nominee end-to-end before picking a real strategy.
 */
export function Memory(options: MemoryOptions = {}): MemoryStrategy {
  const store = new Map<string, TokenResult>()
  const key = (u: string, c: string) => `${u}::${c}`

  for (const [user, conns] of Object.entries(options.tokens ?? {})) {
    for (const [conn, token] of Object.entries(conns)) {
      store.set(key(user, conn), normalize(token))
    }
  }

  return {
    name: 'memory',
    async getToken(params) {
      const found = store.get(key(params.user, params.connection))
      if (found) return found
      if (options.generate) return normalize(options.generate(params))
      throw new Error(
        `nominee(memory): no token for user="${params.user}" connection="${params.connection}"`,
      )
    },
    set(user, connection, token) {
      store.set(key(user, connection), normalize(token))
    },
  }
}
