// What each approach to "use a third-party token in an agent" ACTUALLY does when
// the provider rotates refresh tokens and your agent pauses for human approval.
//
//   A) naive: grab the access token up front, use it after the pause   → 401
//   B) nominee: resolve a fresh token at call time, across the pause   → 200/200
//   C) nominee + 8 concurrent calls: single-flight                     → 1 refresh, 8/8
//   D) "just refresh" with NO single-flight, 8 concurrent              → 8 refreshes, 7/8 fail
//
// A and D are the natural-but-wrong first attempts. B and C are nominee.
import { Nominee, OAuth2 } from 'nominee'
import { startServer } from './oauth-server.mjs'
import { fresh } from './store.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const { port, close } = await startServer({ port: 0 })
const BASE = `http://127.0.0.1:${port}`

// Count real network refreshes by wrapping fetch (nominee uses global fetch).
let refreshCalls = 0
const realFetch = globalThis.fetch
globalThis.fetch = (url, opts) => {
  if (String(url).endsWith('/token')) refreshCalls++
  return realFetch(url, opts)
}
const resetCount = () => {
  refreshCalls = 0
}

async function seed() {
  const r = await fetch(`${BASE}/seed`, { method: 'POST' })
  return (await r.json()).refresh_token
}
async function tokenRefresh(rt) {
  const r = await fetch(`${BASE}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: rt }),
  })
  return { status: r.status, body: await r.json() }
}
async function callResource(at) {
  const r = await fetch(`${BASE}/resource`, { headers: { authorization: `Bearer ${at}` } })
  return { status: r.status, body: await r.json() }
}

// A nominee instance whose refresh token lives in the durable store and whose
// rotated token is written back via onRefreshToken. expiryLeewayMs is small so
// the 2s demo token is served from cache while fresh, refreshed when stale.
function makeNominee(store, key) {
  return new Nominee({
    expiryLeewayMs: 500,
    strategy: OAuth2({
      connections: {
        demo: {
          tokenEndpoint: `${BASE}/token`,
          clientId: 'demo-client',
          refreshToken: () => store.get(key).refreshToken,
          onRefreshToken: (_p, rt) => {
            store.set(key, { ...store.get(key), refreshToken: rt })
          },
        },
      },
    }),
  })
}

// ── A. NAIVE: grab the access token up front, use it after the pause ──────────
async function scenarioA() {
  const rt = await seed()
  const first = await tokenRefresh(rt) // authorize now
  const grabbed = first.body.access_token // hold the ACCESS token (the trap)
  await sleep(2500) // approval pause > 2s TTL
  const out = await callResource(grabbed)
  return `A) naive (hold access token across pause):   resource → ${out.status} ${out.body.error ?? 'OK'}`
}

// ── B. NOMINEE: resolve a fresh token at call time, across the pause ──────────
async function scenarioB() {
  const rt = await seed()
  const store = fresh('./.b.json')
  store.set('alice', { refreshToken: rt })
  const nominee = makeNominee(store, 'alice')
  const at1 = await nominee.token({ user: 'alice', connection: 'demo' })
  const r1 = await callResource(at1)
  await sleep(2500) // the long pause
  const at2 = await nominee.token({ user: 'alice', connection: 'demo' }) // re-resolved fresh
  const r2 = await callResource(at2)
  return `B) nominee (refresh at call time):           before → ${r1.status} OK | after pause → ${r2.status} ${r2.body.ok ? 'OK' : r2.body.error}`
}

// ── C. NOMINEE under concurrency: single-flight means ONE network refresh ─────
async function scenarioC() {
  const rt = await seed()
  const store = fresh('./.c.json')
  store.set('alice', { refreshToken: rt })
  const nominee = makeNominee(store, 'alice')
  await nominee.token({ user: 'alice', connection: 'demo' }) // warm it
  await sleep(2500) // expire
  resetCount()
  const tokens = await Promise.all(
    Array.from({ length: 8 }, () => nominee.token({ user: 'alice', connection: 'demo' })),
  )
  const results = await Promise.all(tokens.map(callResource))
  const ok = results.filter((r) => r.status === 200).length
  return `C) nominee + 8 concurrent calls:             network refreshes = ${refreshCalls} (single-flight) | resource 200s = ${ok}/8`
}

// ── D. "Just refresh" WITHOUT single-flight: rotation makes concurrency break ─
async function scenarioD() {
  const rt = await seed()
  const store = fresh('./.d.json')
  store.set('alice', { refreshToken: rt })
  // The naive-but-refreshes version: every call independently reads the stored
  // refresh token and refreshes. No coalescing, no atomic rotation handling.
  const naiveRefresh = async () => {
    const cur = store.get('alice')
    const out = await tokenRefresh(cur.refreshToken)
    if (out.status !== 200) return { failed: out.body.error }
    store.set('alice', { refreshToken: out.body.refresh_token })
    return { at: out.body.access_token }
  }
  resetCount()
  const outs = await Promise.all(Array.from({ length: 8 }, naiveRefresh))
  const failed = outs.filter((o) => o.failed).length
  return `D) refresh WITHOUT single-flight (8 concurrent): network refreshes = ${refreshCalls} | invalid_grant failures = ${failed}/8`
}

console.log('\n=== Fresh-token-across-the-pause: what each approach actually does ===\n')
console.log(await scenarioA())
console.log(await scenarioB())
console.log(await scenarioC())
console.log(await scenarioD())
console.log('\n(A & D are the natural-but-wrong first attempts. Refresh-token rotation turns')
console.log(' "just refresh the token" into single-flight + atomic persistence — which is')
console.log(' exactly what nominee does for you. B & C are nominee, unchanged agent code.)\n')

await close()
globalThis.fetch = realFetch
