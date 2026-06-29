// A deliberately realistic mock OAuth2 provider. Nothing here is simulated away:
// - access tokens really expire (short TTL) and the resource endpoint returns a real 401
// - refresh tokens ROTATE: each refresh invalidates the old refresh token and issues a new
//   one (this is what GitHub, Google one-time-use, Okta, Auth0 rotation, etc. actually do)
// - /token has real latency, so concurrent refreshes really overlap
//
// The rotation is the important part: it turns "just refresh the token" from a 5-line
// happy path into something that REQUIRES atomic persistence + single-flight, or it breaks.
import { createServer } from 'node:http'

const ACCESS_TTL_MS = 2000 // 2s: short so a "pause" outlives it without waiting an hour
const LATENCY_MS = 150

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Start the mock OAuth2 provider. Pass `port: 0` for an ephemeral port.
 * Returns `{ server, port, close }`.
 */
export function startServer({ port = 0 } = {}) {
  const refreshTokens = new Map() // refresh_token -> { userId, valid }
  const accessTokens = new Map() // access_token -> { userId, exp }
  let counter = 0
  const id = (p) => `${p}_${++counter}_${Math.random().toString(16).slice(2, 8)}`

  function mintAccess(userId) {
    const at = id('at')
    accessTokens.set(at, { userId, exp: Date.now() + ACCESS_TTL_MS })
    return { at, expires_in: ACCESS_TTL_MS / 1000 }
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x')
    const send = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify(obj))
    }

    if (req.method === 'POST' && url.pathname === '/token') {
      await sleep(LATENCY_MS)
      let body = ''
      for await (const c of req) body += c
      const p = new URLSearchParams(body)
      if (p.get('grant_type') !== 'refresh_token')
        return send(400, { error: 'unsupported_grant_type' })
      const rt = p.get('refresh_token')
      const rec = refreshTokens.get(rt)
      if (!rec || !rec.valid) return send(400, { error: 'invalid_grant' }) // rotated-away or revoked
      // ROTATION: burn the old refresh token, issue a new one.
      rec.valid = false
      const newRt = id('rt')
      refreshTokens.set(newRt, { userId: rec.userId, valid: true })
      const { at, expires_in } = mintAccess(rec.userId)
      return send(200, { access_token: at, refresh_token: newRt, expires_in, token_type: 'Bearer' })
    }

    if (req.method === 'POST' && url.pathname === '/seed') {
      const rt = id('rt') // a fresh, un-rotated refresh token, as if consent just completed
      refreshTokens.set(rt, { userId: 'alice', valid: true })
      return send(200, { refresh_token: rt })
    }

    if (req.method === 'GET' && url.pathname === '/resource') {
      const auth = req.headers.authorization || ''
      const at = auth.startsWith('Bearer ') ? auth.slice(7) : ''
      const rec = accessTokens.get(at)
      if (!rec) return send(401, { error: 'invalid_token' })
      if (Date.now() > rec.exp) return send(401, { error: 'token_expired' })
      return send(200, { ok: true, userId: rec.userId, mergedAt: new Date().toISOString() })
    }

    send(404, { error: 'not_found' })
  })

  return new Promise((resolve) => {
    server.listen(port, () => {
      const actual = server.address().port
      resolve({ server, port: actual, close: () => new Promise((r) => server.close(r)) })
    })
  })
}

// Allow running standalone: `node oauth-server.mjs`
if (import.meta.url === `file://${process.argv[1]}`) {
  const { port } = await startServer({ port: Number(process.env.PORT || 8099) })
  console.log(
    `[oauth-server] listening :${port} (access TTL ${ACCESS_TTL_MS}ms, rotating refresh tokens)`,
  )
}
