import type { Strategy, TokenResolver } from '../strategy.js'

/**
 * Wrap a {@link TokenResolver} function into a named strategy. This is the
 * zero-dependency default path — bring tokens you already have (env vars, your
 * database, a literal) and let nominee handle freshness, approval, and audit.
 *
 * You can also pass the resolver directly to `new Nominee({ strategy })`; this
 * helper just gives it a name and a stable identity.
 *
 * ```ts
 * import { Nominee, tokens } from 'nominee'
 *
 * const nominee = new Nominee({
 *   strategy: tokens(({ user, connection }) => db.getToken(user, connection)),
 * })
 * ```
 */
export function tokens(resolver: TokenResolver): Strategy {
  return {
    name: 'tokens',
    async getToken(params) {
      const result = await resolver(params)
      return typeof result === 'string' ? { token: result } : result
    },
  }
}
