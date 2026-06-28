import { ApprovalEngine, type ApprovalRequest } from './approval.js'
import type { AuditEvent } from './audit.js'
import { tokens } from './strategies/tokens.js'
import type {
  ApprovalDecision,
  ApprovalParams,
  ApprovalResult,
  AuthzParams,
  ExchangeParams,
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
  // Not readonly: a delegated sub-agent (see `delegate`) shares the parent's
  // cache, in-flight map, listeners, and approval engine by pointing at them.
  private approvals: ApprovalEngine
  private cache = new Map<string, TokenResult>()
  /** In-flight refreshes — concurrent cache-misses share one fetch (single-flight). */
  private inflight = new Map<string, Promise<TokenResult>>()
  private listeners = new Set<(e: AuditEvent) => void>()
  private readonly expiryLeewayMs: number
  private readonly agent?: string
  /** Delegation chain of agent identities: `[orchestrator, …, sub-agent]`. */
  private chainArr: string[]

  constructor(options: NomineeOptions) {
    this.strategy =
      typeof options.strategy === 'function' ? tokens(options.strategy) : options.strategy
    this.expiryLeewayMs = options.expiryLeewayMs ?? 60_000
    this.agent = options.agent
    this.chainArr = options.agent ? [options.agent] : []
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

  /**
   * Spawn a sub-agent that shares this nominee's strategy, token cache, and
   * audit stream but records an extended identity chain. Every event from the
   * child carries `user → …this chain → actor`, so a delegated action is
   * attributable to the exact sub-agent that took it — not just the orchestrator.
   *
   * ```ts
   * const orchestrator = new Nominee({ strategy, agent: 'orchestrator' })
   * const researcher = orchestrator.delegate('research-agent')
   * await researcher.token({ user, connection: 'github' }) // audit: chain=[orchestrator, research-agent]
   * ```
   */
  delegate(actor: string): Nominee {
    const child = new Nominee({
      strategy: this.strategy,
      agent: this.agent,
      expiryLeewayMs: this.expiryLeewayMs,
    })
    // Share the parent's mutable internals so a sub-agent doesn't refetch what
    // the orchestrator already cached, and its audit events reach the same sinks.
    child.cache = this.cache
    child.inflight = this.inflight
    child.listeners = this.listeners
    child.approvals = this.approvals
    child.chainArr = [...this.chainArr, actor]
    return child
  }

  /**
   * Exchange the user's token for a downscoped one bound to a sub-agent `actor`
   * (RFC 8693 token exchange). Requires a strategy that implements `exchange`.
   * Emits `token.exchanged` with the delegation chain.
   */
  async exchange(params: ExchangeParams): Promise<string> {
    if (!this.strategy.exchange) {
      throw new Error(
        `nominee: strategy "${this.strategy.name}" does not implement exchange() (token exchange)`,
      )
    }
    const result = await this.strategy.exchange(params)
    this.emit({
      type: 'token.exchanged',
      user: params.user,
      connection: params.connection,
      chain: [...this.chainArr, params.actor],
    })
    return result.token
  }

  private cacheKey(user: string, connection: string): string {
    return `${user}::${connection}`
  }

  private isFresh(t: TokenResult | undefined): t is TokenResult {
    if (!t || t.expiresAt === undefined) return false
    return t.expiresAt - this.expiryLeewayMs > Date.now()
  }

  private emit(e: Omit<AuditEvent, 'at' | 'agent'>): void {
    // `agent` is the leaf of the chain — the identity that actually acted.
    const agent = this.chainArr.length ? this.chainArr[this.chainArr.length - 1] : undefined
    const event: AuditEvent = { ...e, agent, at: Date.now() }
    for (const l of this.listeners) l(event)
  }

  private chain(): string[] | undefined {
    return this.chainArr.length ? this.chainArr : undefined
  }
}
