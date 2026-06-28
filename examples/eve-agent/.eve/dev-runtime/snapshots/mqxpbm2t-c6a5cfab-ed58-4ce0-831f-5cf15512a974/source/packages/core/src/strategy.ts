/**
 * A strategy is the neutrality seam of nominee. It knows how to fetch fresh
 * tokens (and, optionally, request approvals / check authorization) for one
 * provider — Auth0, Clerk, a generic OAuth2 endpoint, or your own store.
 *
 * The core engine never talks to a provider directly; it only talks to a
 * Strategy. Swapping providers is swapping the strategy.
 */
export interface Strategy {
  /** Stable identifier, e.g. `"auth0"`, `"oauth2"`, `"memory"`. Used in audit + errors. */
  readonly name: string

  /** Return a token that is valid *now* for this user's connection. Refresh internally. */
  getToken(params: GetTokenParams): Promise<TokenResult>

  /**
   * Ask a human to approve an action. Auth0 implements this with CIBA
   * (push/SMS). If a strategy omits it, the engine falls back to its built-in
   * approval engine (see {@link Nominee.resolveApproval}).
   */
  requestApproval?(params: ApprovalParams): Promise<ApprovalResult>

  /** Fine-grained authorization check (Auth0 FGA). Optional. */
  can?(params: AuthzParams): Promise<boolean>

  /**
   * Exchange a token for a downscoped one bound to a sub-agent actor
   * (RFC 8693 token exchange). Optional; powers sub-agent delegation.
   */
  exchange?(params: ExchangeParams): Promise<TokenResult>
}

export interface GetTokenParams {
  /** The principal the agent acts on behalf of. */
  user: string
  /** The third-party service, e.g. `"github"`, `"slack"`, `"google"`. */
  connection: string
  /** Optional scopes to request/narrow to. */
  scopes?: string[]
}

/**
 * The simplest possible strategy: a function that returns a token (a bare
 * string, or a {@link TokenResult} when you know its expiry). Pass one straight
 * to `new Nominee({ strategy })` — no provider, no signup, install and go.
 *
 * ```ts
 * new Nominee({
 *   strategy: ({ connection }) => process.env[`${connection.toUpperCase()}_TOKEN`]!,
 * })
 * ```
 */
export type TokenResolver = (
  params: GetTokenParams,
) => string | TokenResult | Promise<string | TokenResult>

export interface TokenResult {
  /** The access token to use against the third-party API. */
  token: string
  /** Epoch milliseconds when the token expires. Omit if unknown (won't be cached). */
  expiresAt?: number
  /** Scopes the returned token actually carries. */
  scopes?: string[]
}

export interface ApprovalParams {
  /** The principal whose approval is being requested. */
  user: string
  /** Short machine-readable action name, e.g. `"close_issue"`. */
  action: string
  /** Arbitrary context shown to the approver, e.g. `{ repo, issue }`. */
  detail?: unknown
  /** Override the engine's default wait time (ms) before the request expires. */
  timeoutMs?: number
}

export type ApprovalDecision = 'approved' | 'denied' | 'expired'

export interface ApprovalResult {
  /** Identifier of the approval request. */
  id: string
  /** The outcome. */
  decision: ApprovalDecision
}

export interface AuthzParams {
  user: string
  action: string
  /** The resource being acted on, e.g. `"doc:42"`. */
  resource: string
}

export interface ExchangeParams {
  user: string
  connection: string
  /** Identity of the sub-agent that will receive the downscoped token. */
  actor: string
  scopes?: string[]
}
