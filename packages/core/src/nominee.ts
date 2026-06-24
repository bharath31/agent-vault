import { ApprovalEngine, type ApprovalRequest } from './approval.js'
import type { AuditEvent } from './audit.js'
import { tokens } from './strategies/tokens.js'
import type {
  ApprovalDecision,
  ApprovalParams,
  ApprovalResult,
  AuthzParams,
  GetTokenParams,
  Strategy,
  TokenResolver,
  TokenResult,
} from './strategy.js'

export interface NomineeOptions {
  /**
   * How tokens are brokered. Either a full {@link Strategy} (Auth0, OAuth2, …)
   * or — the simplest path — a plain {@link TokenResolver} function that returns
   * a token. A function needs no provider and no signup.
   */
  strategy: Strategy | TokenResolver
  /** Called when an approval is pending and the strategy has no native flow. */
  onApprovalRequest?: (req: ApprovalRequest) => void | Promise<void>
  /** Receive every audit event. */
  onAudit?: (event: AuditEvent) => void
  /** Default approval wait time in ms before expiring. `0` = wait forever. */
  approvalTimeoutMs?: number
  /** Treat tokens as stale this many ms before real expiry. Default 60_000. */
  expiryLeewayMs?: number
  /** Acting agent identity, recorded in the audit chain. */
  agent?: string
}

export interface TokenParams extends GetTokenParams {
  /** Bypass the cache and force a fresh fetch from the strategy. */
  force?: boolean
}

/** Thrown by {@link Nominee.approve} when a request is denied or expires. */
export class ApprovalDeniedError extends Error {
  constructor(readonly result: ApprovalResult) {
    super(`nominee: approval ${result.decision} (id=${result.id})`)
    this.name = 'ApprovalDeniedError'
  }
}

/**
 * The nominee engine. An agent asks it for a fresh token *at the moment* of a
 * tool call (never captures one up front), gates sensitive actions behind
 * human approval, and emits an auditable identity chain.
 */
export class Nominee {
  readonly strategy: Strategy
  private readonly approvals: ApprovalEngine
  private readonly cache = new Map<string, TokenResult>()
  /** In-flight refreshes — concurrent cache-misses share one fetch (single-flight). */
  private readonly inflight = new Map<string, Promise<TokenResult>>()
  private readonly listeners = new Set<(e: AuditEvent) => void>()
  private readonly expiryLeewayMs: number
  private readonly agent?: string

  constructor(options: NomineeOptions) {
    this.strategy =
      typeof options.strategy === 'function' ? tokens(options.strategy) : options.strategy
    this.expiryLeewayMs = options.expiryLeewayMs ?? 60_000
    this.agent = options.agent
    if (options.onAudit) this.listeners.add(options.onAudit)
    this.approvals = new ApprovalEngine(options.onApprovalRequest, options.approvalTimeoutMs ?? 0)
  }

  /** Subscribe to audit events. Returns an unsubscribe function. */
  on(listener: (e: AuditEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Get a token that is valid right now for the user's connection.
   * Cached per (user, connection) until shortly before expiry, then refreshed
   * transparently — this is what survives long-running / durable execution.
   */
  async token(params: TokenParams): Promise<string> {
    const { user, connection, scopes, force } = params
    const key = this.cacheKey(user, connection)

    if (!force) {
      const cached = this.cache.get(key)
      if (this.isFresh(cached)) {
        this.emit({ type: 'token.cached', user, connection, chain: this.chain() })
        return cached.token
      }
      // Coalesce: if a refresh for this key is already in flight, wait for it
      // instead of starting a second one (prevents refresh stampedes when a
      // long-running agent fires many tool calls at once).
      const pending = this.inflight.get(key)
      if (pending) {
        const result = await pending
        this.emit({ type: 'token.cached', user, connection, chain: this.chain() })
        return result.token
      }
    }

    const fetchPromise = this.strategy.getToken({ user, connection, scopes })
    // `force` always fetches its own token and never coalesces with others.
    if (!force) this.inflight.set(key, fetchPromise)

    try {
      const result = await fetchPromise
      // Only cache when expiry is known; otherwise always re-fetch to stay safe.
      if (result.expiresAt !== undefined) this.cache.set(key, result)
      else this.cache.delete(key)
      this.emit({ type: 'token.issued', user, connection, chain: this.chain() })
      return result.token
    } catch (err) {
      this.emit({
        type: 'token.error',
        user,
        connection,
        chain: this.chain(),
        detail: err instanceof Error ? err.message : String(err),
      })
      throw err
    } finally {
      if (!force) this.inflight.delete(key)
    }
  }

  /**
   * Drop any cached token for (user, connection) so the next {@link token} call
   * re-resolves from the strategy. Call this after you revoke access upstream
   * (at your provider or token store): because nominee resolves at call time and
   * never holds a token longer than the cache, the revocation takes effect on the
   * very next call — `invalidate` just makes it immediate instead of waiting out
   * the expiry leeway. Returns true if a cached entry was removed.
   */
  invalidate(user: string, connection: string): boolean {
    const removed = this.cache.delete(this.cacheKey(user, connection))
    this.emit({ type: 'token.invalidated', user, connection, chain: this.chain() })
    return removed
  }

  /**
   * Block until a human approves `action`. Uses the strategy's native flow
   * (e.g. Auth0 CIBA) if present, otherwise the built-in engine — settle those
   * via {@link resolveApproval}. Throws {@link ApprovalDeniedError} on
   * denial/expiry.
   */
  async approve(params: ApprovalParams): Promise<ApprovalResult> {
    const { user, action } = params
    this.emit({
      type: 'approval.requested',
      user,
      action,
      chain: this.chain(),
      detail: params.detail,
    })

    const result = this.strategy.requestApproval
      ? await this.strategy.requestApproval(params)
      : await this.approvals.request(params)

    this.emit({
      type: 'approval.resolved',
      user,
      action,
      decision: result.decision,
      chain: this.chain(),
    })

    if (result.decision !== 'approved') throw new ApprovalDeniedError(result)
    return result
  }

  /**
   * Settle a pending approval created by the built-in engine — call this from
   * your approval webhook/handler. No-op (returns false) for strategy-native
   * flows or unknown ids.
   */
  resolveApproval(id: string, decision: ApprovalDecision): boolean {
    return this.approvals.resolve(id, decision)
  }

  /** Fine-grained authorization check. Requires a strategy that implements `can`. */
  async can(params: AuthzParams): Promise<boolean> {
    if (!this.strategy.can) {
      throw new Error(
        `nominee: strategy "${this.strategy.name}" does not implement can() (authorization)`,
      )
    }
    const allowed = await this.strategy.can(params)
    this.emit({
      type: 'authz.checked',
      user: params.user,
      action: params.action,
      resource: params.resource,
      decision: allowed,
      chain: this.chain(),
    })
    return allowed
  }

  private cacheKey(user: string, connection: string): string {
    return `${user}::${connection}`
  }

  private isFresh(t: TokenResult | undefined): t is TokenResult {
    if (!t || t.expiresAt === undefined) return false
    return t.expiresAt - this.expiryLeewayMs > Date.now()
  }

  private emit(e: Omit<AuditEvent, 'at' | 'agent'>): void {
    const event: AuditEvent = { ...e, agent: this.agent, at: Date.now() }
    for (const l of this.listeners) l(event)
  }

  private chain(): string[] | undefined {
    return this.agent ? [this.agent] : undefined
  }
}
