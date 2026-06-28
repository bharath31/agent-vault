import { describe, expect, it, vi } from 'vitest'
import { ApprovalDeniedError, ApprovalEngine, Memory, Nominee } from '../src/index.js'
import type { ApprovalRequest } from '../src/index.js'

describe('ApprovalEngine', () => {
  it('lets onApprovalRequest settle inline via req.approve()/deny()/resolve()', async () => {
    const n = new Nominee({
      strategy: Memory(),
      onApprovalRequest: (req) => req.approve(), // no need to capture the instance
    })
    await expect(n.approve({ user: 'u1', action: 'x' })).resolves.toMatchObject({
      decision: 'approved',
    })

    const denier = new Nominee({ strategy: Memory(), onApprovalRequest: (req) => req.deny() })
    await expect(denier.approve({ user: 'u1', action: 'y' })).rejects.toBeInstanceOf(
      ApprovalDeniedError,
    )

    const resolver = new Nominee({
      strategy: Memory(),
      onApprovalRequest: (req) => req.resolve('approved'),
    })
    await expect(resolver.approve({ user: 'u1', action: 'z' })).resolves.toMatchObject({
      decision: 'approved',
    })
  })

  it('resolves when settled with approved', async () => {
    let captured: ApprovalRequest | undefined
    const engine = new ApprovalEngine((req) => {
      captured = req
    })
    const p = engine.request({ user: 'u1', action: 'close_issue' })
    await vi.waitFor(() => expect(captured).toBeDefined())
    expect(engine.resolve(captured!.id, 'approved')).toBe(true)
    expect(await p).toEqual({ id: captured!.id, decision: 'approved' })
  })

  it('expires after the timeout', async () => {
    const engine = new ApprovalEngine(undefined, 10)
    const result = await engine.request({ user: 'u1', action: 'x' })
    expect(result.decision).toBe('expired')
  })

  it('resolve() returns false for unknown ids', () => {
    const engine = new ApprovalEngine()
    expect(engine.resolve('nope', 'approved')).toBe(false)
  })

  it('tracks pending size', async () => {
    const engine = new ApprovalEngine()
    let id = ''
    engine.request({ user: 'u', action: 'a' })
    // capture id via a second engine path: use onRequest
    const e2 = new ApprovalEngine((req) => {
      id = req.id
    })
    e2.request({ user: 'u', action: 'a' })
    await vi.waitFor(() => expect(id).not.toBe(''))
    expect(engine.size).toBe(1)
    expect(e2.size).toBe(1)
    e2.resolve(id, 'denied')
    expect(e2.size).toBe(0)
  })
})

describe('Nominee.approve', () => {
  it('resolves via the built-in engine when approved', async () => {
    let pending: ApprovalRequest | undefined
    const n = new Nominee({
      strategy: Memory(),
      onApprovalRequest: (req) => {
        pending = req
      },
    })
    const promise = n.approve({ user: 'u1', action: 'close_issue', detail: { issue: 42 } })
    await vi.waitFor(() => expect(pending).toBeDefined())
    n.resolveApproval(pending!.id, 'approved')
    await expect(promise).resolves.toMatchObject({ decision: 'approved' })
  })

  it('throws ApprovalDeniedError on denial', async () => {
    let pending: ApprovalRequest | undefined
    const n = new Nominee({
      strategy: Memory(),
      onApprovalRequest: (req) => {
        pending = req
      },
    })
    const promise = n.approve({ user: 'u1', action: 'delete_repo' })
    await vi.waitFor(() => expect(pending).toBeDefined())
    n.resolveApproval(pending!.id, 'denied')
    await expect(promise).rejects.toBeInstanceOf(ApprovalDeniedError)
  })

  it('uses the strategy native flow when present', async () => {
    const requestApproval = vi.fn(async () => ({ id: 'ciba_1', decision: 'approved' as const }))
    const n = new Nominee({
      strategy: { name: 'auth0', getToken: async () => ({ token: 't' }), requestApproval },
    })
    await expect(n.approve({ user: 'u1', action: 'x' })).resolves.toMatchObject({ id: 'ciba_1' })
    expect(requestApproval).toHaveBeenCalledOnce()
  })
})
