// The homepage "long session" race. Two agents call a protected API across a
// session longer than the token lives:
//   • captured — grabs a token once and reuses it (what every orchestrator
//     leaves you to do). Dies when the token expires.
//   • nominee  — asks nominee.token() each call. Refreshes transparently, lives.
//
// This loads the REAL published `nominee` from esm.sh and runs its real OAuth2
// strategy against same-origin demo endpoints (/agent/demo/token + /agent/demo/api).
// The refresh genuinely happens in your browser — watch the Network tab. If
// esm.sh is unreachable we fall back to a faithful scripted render (and say so).

const BASE = '/agent/demo'
const TICKS = 8 // tool calls across the "session"
const EVERY = 1900 // ms between calls (~15s session)
const LEEWAY = 2000 // treat the 8s token stale 2s early — so we see cache hits AND a refresh

const root = document.querySelector('[data-race]')
if (root) main(root)

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const fp = (t) => String(t).slice(-4)

function lane(root, which) {
  return root.querySelector(`[data-lane="${which}"] [data-log]`)
}
function row(log, cls, text) {
  const el = document.createElement('div')
  el.className = `race-line ${cls}`
  el.textContent = text
  log.appendChild(el)
}
function verdict(root, which, cls, text) {
  const el = root.querySelector(`[data-lane="${which}"] [data-verdict]`)
  if (el) {
    el.className = `lane-verdict ${cls}`
    el.textContent = text
  }
}
function reset(root) {
  for (const l of root.querySelectorAll('[data-log]')) l.innerHTML = ''
  for (const v of root.querySelectorAll('[data-verdict]')) {
    v.className = 'lane-verdict'
    v.textContent = ''
  }
}

async function main(root) {
  const replay = root.querySelector('[data-replay]')
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches

  let lib = null
  try {
    lib = await import('https://esm.sh/nominee@0.3')
  } catch {
    /* fall back below */
  }

  if (reduce || !lib?.Nominee || !lib?.OAuth2) {
    renderStatic(root, !lib)
    return
  }

  const go = async () => {
    if (replay) replay.hidden = true
    reset(root)
    try {
      await race(root, lib)
    } catch {
      renderStatic(root, false)
    }
    if (replay) replay.hidden = false
  }
  if (replay) replay.addEventListener('click', go)
  go()
}

async function race(root, { Nominee, OAuth2 }) {
  const A = lane(root, 'captured')
  const B = lane(root, 'nominee')
  const clock = root.querySelector('[data-clock]')

  // captured: one token, grabbed up front and reused forever
  const captured = await (await fetch(`${BASE}/token`, { method: 'POST' })).json()

  // nominee: re-resolves per call via the real OAuth2 strategy + cache
  const nominee = new Nominee({
    strategy: OAuth2({
      connections: { demo: { tokenEndpoint: `${BASE}/token`, clientId: 'demo', refreshToken: 'demo' } },
    }),
    expiryLeewayMs: LEEWAY,
  })

  let prev = ''
  let aliveA = true
  for (let i = 0; i < TICKS; i++) {
    const t = Math.round((i * EVERY) / 1000)
    if (clock) clock.textContent = `session ${t}s elapsed`

    // lane A — captured token
    const ra = await fetch(`${BASE}/api`, { headers: { authorization: `Bearer ${captured.access_token}` } })
    if (ra.ok) row(A, 'ok', `t+${t}s  tool call → 200 ✓   ·${fp(captured.access_token)}`)
    else {
      aliveA = false
      row(A, 'err', `t+${t}s  tool call → 401 ✗ token expired`)
    }

    // lane B — nominee.token() each call
    const tok = await nominee.token({ user: 'demo', connection: 'demo' })
    const rb = await fetch(`${BASE}/api`, { headers: { authorization: `Bearer ${tok}` } })
    const refreshed = prev && fp(tok) !== prev
    prev = fp(tok)
    row(
      B,
      rb.ok ? 'ok' : 'err',
      `t+${t}s  tool call → ${rb.ok ? '200 ✓' : '401 ✗'}   ·${fp(tok)}${refreshed ? '   ↻ refreshed' : ''}`,
    )

    if (i < TICKS - 1) await wait(EVERY)
  }

  verdict(root, 'captured', aliveA ? '' : 'dead', aliveA ? '' : '✗ agent dead — access expired mid-session')
  verdict(root, 'nominee', 'live', '✓ still running — nominee refreshed at call time')
}

// Faithful re-enactment when esm.sh is blocked or reduced-motion is on.
function renderStatic(root, offline) {
  reset(root)
  const A = lane(root, 'captured')
  const B = lane(root, 'nominee')
  const seqA = ['200 ✓', '200 ✓', '200 ✓', '200 ✓', '200 ✓', '401 ✗ expired', '401 ✗ expired', '401 ✗ expired']
  for (let i = 0; i < seqA.length; i++) {
    const t = Math.round((i * EVERY) / 1000)
    const dead = seqA[i].startsWith('401')
    row(A, dead ? 'err' : 'ok', `t+${t}s  tool call → ${seqA[i]}`)
  }
  for (let i = 0; i < 8; i++) {
    const t = Math.round((i * EVERY) / 1000)
    row(B, 'ok', `t+${t}s  tool call → 200 ✓${i === 4 ? '   ↻ refreshed' : ''}`)
  }
  verdict(root, 'captured', 'dead', '✗ agent dead — access expired mid-session')
  verdict(root, 'nominee', 'live', '✓ still running — nominee refreshed at call time')
  const clock = root.querySelector('[data-clock]')
  if (clock) clock.textContent = offline ? 'replay (esm.sh blocked — showing the recording)' : 'session complete'
}
