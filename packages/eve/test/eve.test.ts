import { Memory, Nominee } from 'nominee'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { nomineeTool, withNominee } from '../src/index.js'

// Minimal stand-in for Eve's ToolContext (the runtime passes the real one).
const fakeCtx = { session: { userId: 'u1' } } as never

function makeNominee(over: Partial<ConstructorParameters<typeof Nominee>[0]> = {}) {
  return new Nominee({
    strategy: Memory({ tokens: { u1: { github: 'gh_tok_123' } } }),
    ...over,
  })
}

describe('nominee-eve', () => {
  it('produces a tool with an execute function', () => {
    const tool = nomineeTool({
      nominee: makeNominee(),
      user: 'u1',
      description: 'noop',
      inputSchema: z.object({ x: z.number() }),
      execute: async ({ x }) => x,
    })
    expect(typeof tool.execute).toBe('function')
  })

  it('injects a fresh token for the connection', async () => {
    let seen: string | undefined
    const tool = nomineeTool({
      nominee: makeNominee(),
      user: 'u1',
      connection: 'github',
      description: 'use gh',
      inputSchema: z.object({ repo: z.string() }),
      execute: async (_input, { token }) => {
        seen = token
        return 'ok'
      },
    })
    await tool.execute({ repo: 'a/b' }, fakeCtx)
    expect(seen).toBe('gh_tok_123')
  })

  it('resolves the user from a function of ctx', async () => {
    let seenUser: string | undefined
    const tool = nomineeTool({
      nominee: makeNominee(),
      user: (ctx) => (ctx as unknown as { session: { userId: string } }).session.userId,
      description: 'whoami',
      inputSchema: z.object({}),
      execute: async (_input, { user }) => {
        seenUser = user
        return user
      },
    })
    await tool.execute({}, fakeCtx)
    expect(seenUser).toBe('u1')
  })

  it('requires approval before execute and proceeds when approved', async () => {
    const executed = vi.fn(async () => 'done')
    const nominee = makeNominee({
      onApprovalRequest: (req) => {
        nominee.resolveApproval(req.id, 'approved')
      },
    })
    const tool = nomineeTool({
      nominee,
      user: 'u1',
      approval: true,
      action: 'close_issue',
      description: 'close',
      inputSchema: z.object({ issue: z.number() }),
      execute: executed,
    })
    await expect(tool.execute({ issue: 1 }, fakeCtx)).resolves.toBe('done')
    expect(executed).toHaveBeenCalledOnce()
  })

  it('aborts execute when approval is denied', async () => {
    const executed = vi.fn(async () => 'done')
    const nominee = makeNominee({
      onApprovalRequest: (req) => {
        nominee.resolveApproval(req.id, 'denied')
      },
    })
    const tool = nomineeTool({
      nominee,
      user: 'u1',
      approval: true,
      description: 'danger',
      inputSchema: z.object({}),
      execute: executed,
    })
    await expect(tool.execute({}, fakeCtx)).rejects.toThrow(/approval denied/)
    expect(executed).not.toHaveBeenCalled()
  })

  it('withNominee binds the instance and default user', async () => {
    const tool = withNominee(makeNominee(), { user: 'u1' })({
      connection: 'github',
      description: 'bound',
      inputSchema: z.object({}),
      execute: async (_input, { token, user }) => `${user}:${token}`,
    })
    await expect(tool.execute({}, fakeCtx)).resolves.toBe('u1:gh_tok_123')
  })
})
