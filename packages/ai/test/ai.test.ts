import { Memory, Nominee } from 'nominee'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { nomineeTool, withNominee } from '../src/index.js'

// Minimal stand-in for the AI SDK's ToolCallOptions.
const fakeOptions = { toolCallId: 'call_1', messages: [] } as never

function makeNominee(over: Partial<ConstructorParameters<typeof Nominee>[0]> = {}) {
  return new Nominee({
    strategy: Memory({ tokens: { u1: { github: 'gh_tok_123' } } }),
    ...over,
  })
}

// AI SDK tools may carry execute as optional; tests invoke it directly.
function exec(tool: { execute?: (...args: any[]) => any }, input: unknown) {
  if (typeof tool.execute !== 'function') throw new Error('tool has no execute')
  return tool.execute(input, fakeOptions)
}

describe('nominee-ai', () => {
  it('produces an AI SDK tool with description + execute', () => {
    const tool = nomineeTool({
      nominee: makeNominee(),
      user: 'u1',
      description: 'noop',
      inputSchema: z.object({ x: z.number() }),
      execute: async ({ x }) => x,
    })
    expect(tool.description).toBe('noop')
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
    await exec(tool, { repo: 'a/b' })
    expect(seen).toBe('gh_tok_123')
  })

  it('resolves the user from a function of the tool-call options', async () => {
    let seenUser: string | undefined
    const tool = nomineeTool({
      nominee: makeNominee(),
      user: (options) => (options.toolCallId === 'call_1' ? 'u1' : 'other'),
      description: 'whoami',
      inputSchema: z.object({}),
      execute: async (_input, { user }) => {
        seenUser = user
        return user
      },
    })
    await exec(tool, {})
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
    await expect(exec(tool, { issue: 1 })).resolves.toBe('done')
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
    await expect(exec(tool, {})).rejects.toThrow(/approval denied/)
    expect(executed).not.toHaveBeenCalled()
  })

  it('withNominee binds the instance and default user', async () => {
    const tool = withNominee(makeNominee(), { user: 'u1' })({
      connection: 'github',
      description: 'bound',
      inputSchema: z.object({}),
      execute: async (_input, { token, user }) => `${user}:${token}`,
    })
    await expect(exec(tool, {})).resolves.toBe('u1:gh_tok_123')
  })
})
