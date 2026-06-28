import type { ApprovalDecision, ApprovalParams, ApprovalResult } from './strategy.js'

export interface ApprovalRequest extends ApprovalParams {
  /** Unique id for this pending request; pass it to `resolveApproval(id, …)`. */
  id: string
  /** Approve this request inline — no need to capture the Nominee instance. */
  approve(): void
  /** Deny this request inline. */
  deny(): void
  /** Settle this request with an explicit decision. */
  resolve(decision: ApprovalDecision): void
}

interface Pending {
  resolve: (r: ApprovalResult) => void
  timer?: ReturnType<typeof setTimeout>
}

/**
 * The built-in human-in-the-loop engine, used when the active strategy does
 * not provide a native `requestApproval` (e.g. Auth0 CIBA).
 *
 * Flow: `request()` creates a pending record, invokes `onRequest` (where you
 * notify the user — Slack, SMS, email, a dashboard), and returns a promise.
 * Your webhook later calls `resolve(id, decision)` to settle it. Requests can
 * optionally expire after a timeout.
 */
export class ApprovalEngine {
  private pending = new Map<string, Pending>()
  private seq = 0

  constructor(
    private readonly onRequest?: (req: ApprovalRequest) => void | Promise<void>,
    private readonly defaultTimeoutMs = 0,
  ) {}

  async request(params: ApprovalParams): Promise<ApprovalResult> {
    const id = `apr_${Date.now().toString(36)}_${(this.seq++).toString(36)}`
    const req: ApprovalRequest = {
      ...params,
      id,
      approve: () => {
        this.resolve(id, 'approved')
      },
      deny: () => {
        this.resolve(id, 'denied')
      },
      resolve: (decision) => {
        this.resolve(id, decision)
      },
    }

    const promise = new Promise<ApprovalResult>((resolve) => {
      const timeoutMs = params.timeoutMs ?? this.defaultTimeoutMs
      let timer: ReturnType<typeof setTimeout> | undefined
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          this.pending.delete(id)
          resolve({ id, decision: 'expired' })
        }, timeoutMs)
        // Don't keep the process alive solely for a pending approval.
        timer.unref?.()
      }
      this.pending.set(id, { resolve, timer })
    })

    await this.onRequest?.(req)
    return promise
  }

  /** Settle a pending request. Returns false if the id is unknown/already settled. */
  resolve(id: string, decision: ApprovalDecision): boolean {
    const p = this.pending.get(id)
    if (!p) return false
    if (p.timer) clearTimeout(p.timer)
    this.pending.delete(id)
    p.resolve({ id, decision })
    return true
  }

  /** Number of currently-pending requests. */
  get size(): number {
    return this.pending.size
  }
}
