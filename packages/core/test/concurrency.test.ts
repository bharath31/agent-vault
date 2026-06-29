import { describe, expect, it } from 'vitest'
import { Nominee } from '../src/nominee.js'

describe('engine single-flight', () => {
  it('coalesces concurrent token() calls for the same key into one fetch', async () => {
    let calls = 0
    const nominee = new Nominee({
      strategy: async () => {
        calls++
        await new Promise((r) => setTimeout(r, 20))
        return { token: `at_${calls}`, expiresAt: Date.now() + 60_000 }
      },
    })
    const results = await Promise.all(
      Array.from({ length: 8 }, () => nominee.token({ user: 'alice', connection: 'github' })),
    )
    expect(calls).toBe(1) // single-flight: 8 concurrent calls -> 1 fetch
    expect(new Set(results).size).toBe(1) // all got the same token
  })
})
