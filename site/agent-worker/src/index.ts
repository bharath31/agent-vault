import { Nominee } from 'nominee'
import { Auth0 } from 'nominee-auth0'

interface RateLimit {
  limit(opts: { key: string }): Promise<{ success: boolean }>
}
interface Env {
  STAR_RL: RateLimit
  AUTH0_DOMAIN: string
  AUTH0_CLIENT_ID: string
  AUTH0_CLIENT_SECRET: string
  SESSION_SECRET: string
  SESSIONS: DurableObjectNamespace
  RESEND_API_KEY: string
  FROM: string
}

const ORIGIN = 'https://nominee.dev'
const REDIRECT = `${ORIGIN}/agent/callback`
const CONNECT_REDIRECT = `${ORIGIN}/agent/connect/callback`
const COOKIE = 'nominee_sess'
// My Account API audience + the Connected Accounts scopes needed to vault a GitHub token.
const meAudience = (domain: string) => `https://${domain}/me/`
const CA_SCOPES =
  'openid profile offline_access create:me:connected_accounts read:me:connected_accounts delete:me:connected_accounts'

const json = (d: unknown, s = 200) =>
  new Response(JSON.stringify(d, null, 2), {
    status: s,
    headers: { 'content-type': 'application/json' },
  })
const cleanTopic = (s: unknown): string | null => {
  const t = String(s ?? '')
    .trim()
    .slice(0, 140)
  return t.length ? t : null
}

// ---- encrypted session cookie (AES-GCM via Web Crypto; no KV needed) ----
async function aesKey(secret: string) {
  const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}
async function seal(secret: string, data: object) {
  const key = await aesKey(secret)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const pt = new TextEncoder().encode(JSON.stringify(data))
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, pt))
  return `${b64(iv)}.${b64(ct)}`
}
async function unseal<T>(secret: string, token: string): Promise<T | null> {
  try {
    const [ivb, ctb] = token.split('.')
    const key = await aesKey(secret)
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ub64(ivb) }, key, ub64(ctb))
    return JSON.parse(new TextDecoder().decode(pt)) as T
  } catch {
    return null
  }
}
const b64 = (a: Uint8Array) => btoa(String.fromCharCode(...a))
const ub64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
const getCookie = (req: Request, name: string) =>
  (req.headers.get('cookie') || '').match(new RegExp(`${name}=([^;]+)`))?.[1]

interface Session {
  sub: string
  name?: string
  email?: string
  refreshToken: string
  vaulted?: boolean
  authSession?: string
  connectState?: string
}

// Exchange the Auth0 refresh token (bound to the My Account API audience) for a
// short-lived My Account API access token, used to drive the Connected Accounts flow.
async function myAccountToken(env: Env, refreshToken: string): Promise<string> {
  const res = await fetch(`https://${env.AUTH0_DOMAIN}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: env.AUTH0_CLIENT_ID,
      client_secret: env.AUTH0_CLIENT_SECRET,
      refresh_token: refreshToken,
      audience: meAudience(env.AUTH0_DOMAIN),
      scope: CA_SCOPES,
    }),
  })
  const j = (await res.json().catch(() => ({}))) as {
    access_token?: string
    error_description?: string
    error?: string
  }
  if (!j.access_token)
    throw new Error(
      `My Account token exchange failed (${res.status}) ${j.error_description ?? j.error ?? 'no access_token'}`,
    )
  return j.access_token
}

// ---- Auth0 Management API: client-credentials token + Guardian enrollment ----
// Cached per isolate so polling the enrollment status doesn't mint a token each tick.
let _mgmt: { token: string; exp: number } | null = null
async function mgmtToken(env: Env): Promise<string> {
  if (_mgmt && _mgmt.exp > Date.now() + 30_000) return _mgmt.token
  const res = await fetch(`https://${env.AUTH0_DOMAIN}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: env.AUTH0_CLIENT_ID,
      client_secret: env.AUTH0_CLIENT_SECRET,
      audience: `https://${env.AUTH0_DOMAIN}/api/v2/`,
    }),
  })
  const j = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number }
  if (!j.access_token) throw new Error('management API token request failed')
  _mgmt = { token: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000 }
  return j.access_token
}

interface Enrollment {
  id: string
  device: string
}

// Returns the user's confirmed Guardian push enrollment, or null. Resilient:
// any failure resolves to null so the email path is never blocked.
async function getEnrollment(env: Env, userId: string): Promise<Enrollment | null> {
  try {
    const token = await mgmtToken(env)
    const res = await fetch(
      `https://${env.AUTH0_DOMAIN}/api/v2/users/${encodeURIComponent(userId)}/authentication-methods`,
      { headers: { authorization: `Bearer ${token}` } },
    )
    if (!res.ok) return null
    const methods = (await res.json()) as Array<{
      id: string
      type: string
      name?: string
      confirmed?: boolean
    }>
    const g = methods.find((m) => m.type === 'guardian' && m.confirmed !== false)
    return g ? { id: g.id, device: g.name || 'your phone' } : null
  } catch {
    return null
  }
}

// Seal the session and return a 302 that sets the cookie + redirects to `location`.
async function setSession(env: Env, sess: Session, location: string): Promise<Response> {
  const val = await seal(env.SESSION_SECRET, sess)
  return new Response(null, {
    status: 302,
    headers: {
      location,
      'set-cookie': `${COOKIE}=${val}; HttpOnly; Secure; SameSite=Lax; Path=/agent; Max-Age=3600`,
    },
  })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname.replace(/\/+$/, '') || '/agent'

    // ---- 0. public demo endpoints for the homepage "long session" race ----
    // A signup-free, short-TTL (8s) token source + a guarded resource. The site
    // runs the REAL published `nominee` (from esm.sh) against these, so the
    // refresh you see in the browser is genuine, not a re-enactment. Stateless:
    // the access token is just a sealed `{ exp }` (the random IV makes each issue
    // unique, so the token fingerprint visibly changes on refresh).
    if (path.endsWith('/demo/token')) {
      const access = await seal(env.SESSION_SECRET, { exp: Date.now() + 8000 })
      return json({
        access_token: access,
        token_type: 'bearer',
        expires_in: 8,
        refresh_token: 'demo',
      })
    }
    if (path.endsWith('/demo/api')) {
      const tok = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '')
      const claims = tok ? await unseal<{ exp: number }>(env.SESSION_SECRET, tok) : null
      if (!claims || claims.exp <= Date.now())
        return json({ ok: false, error: 'expired_token' }, 401)
      return json({ ok: true, validForMs: claims.exp - Date.now() }, 200)
    }

    // ---- session routes (durable, multi-step agent) ----
    // Approve / deny arrive from the EMAIL link - no cookie required (the magic
    // key authorizes the act, and the Durable Object holds the user's refresh
    // token to re-resolve a fresh GitHub token at action time).
    if (path.endsWith('/approve') || path.endsWith('/deny')) {
      const id = url.searchParams.get('id')
      const k = url.searchParams.get('k')
      if (!id || !k) return new Response('Missing id or key.', { status: 400 })
      const decision = path.endsWith('/approve') ? 'approved' : 'denied'
      const stub = env.SESSIONS.get(env.SESSIONS.idFromName(id))
      const r = await stub.fetch(
        `https://do/resolve?decision=${decision}&k=${encodeURIComponent(k)}`,
      )
      const out = (await r.json().catch(() => ({}))) as { ok?: boolean; gistUrl?: string }
      return new Response(approvalLandingPage(decision, out, id), {
        status: r.status,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    }
    // Poll a session's live state (the console UI reads this).
    if (path.includes('/session/') && request.method === 'GET') {
      const id = path.split('/session/')[1]
      if (!id) return json({ ok: false, reason: 'no_id' }, 400)
      const stub = env.SESSIONS.get(env.SESSIONS.idFromName(id))
      return stub.fetch('https://do/state')
    }

    // ---- 1. login: authenticate the user via GitHub, requesting a refresh token
    //         scoped to the My Account API (so we can drive Connected Accounts) ----
    if (path.endsWith('/login')) {
      const u = new URL(`https://${env.AUTH0_DOMAIN}/authorize`)
      u.searchParams.set('response_type', 'code')
      u.searchParams.set('client_id', env.AUTH0_CLIENT_ID)
      u.searchParams.set('redirect_uri', REDIRECT)
      // Request the My Account API audience explicitly so the tenant default
      // audience (which may have offline_access disabled) doesn't suppress the
      // refresh token. The MRRT policy on the app allows this refresh token to
      // be exchanged for connected-accounts scopes during /connect.
      u.searchParams.set('audience', meAudience(env.AUTH0_DOMAIN))
      u.searchParams.set('scope', 'openid profile email offline_access')
      u.searchParams.set('connection', 'github') // primary auth via GitHub
      return Response.redirect(u.toString(), 302)
    }

    // ---- 2. callback: exchange code → store the Auth0 refresh token in a sealed cookie ----
    if (path.endsWith('/callback') && !path.endsWith('/connect/callback')) {
      const code = url.searchParams.get('code')
      if (!code) return Response.redirect(`${ORIGIN}/agent`, 302)
      const res = await fetch(`https://${env.AUTH0_DOMAIN}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: env.AUTH0_CLIENT_ID,
          client_secret: env.AUTH0_CLIENT_SECRET,
          code,
          redirect_uri: REDIRECT,
        }),
      })
      const tok = (await res.json().catch(() => ({}))) as {
        refresh_token?: string
        id_token?: string
        error_description?: string
      }
      if (!tok.refresh_token)
        return new Response(
          `Login failed: ${tok.error_description ?? 'no refresh token (enable offline_access + Refresh Token grant)'}`,
          { status: 400 },
        )
      const claims = tok.id_token ? decodeJwt(tok.id_token) : {}
      const prior = await getSession(request, env)
      const sess: Session = {
        sub: claims.sub ?? 'user',
        name: claims.name ?? claims.nickname,
        email: claims.email,
        refreshToken: tok.refresh_token,
        vaulted: prior?.vaulted ?? false,
      }
      return setSession(env, sess, `${ORIGIN}/agent`)
    }

    if (path.endsWith('/logout')) {
      return new Response(null, {
        status: 302,
        headers: {
          location: `${ORIGIN}/agent`,
          'set-cookie': `${COOKIE}=; Path=/agent; Max-Age=0`,
        },
      })
    }

    const session = await getSession(request, env)

    // ---- 2b. enroll: generate a Guardian enrollment ticket and redirect to it ----
    // The acr_values approach only triggers MFA login, not enrollment. The
    // Management API enrollment ticket is the only reliable way to get Auth0
    // to show the Guardian QR code.
    // Mint a single-use Guardian enrollment ticket. Returns JSON for the popup
    // flow on the testbed page (the page opens ticket_url in a popup and polls).
    if (path.endsWith('/enroll')) {
      if (!session) return json({ ok: false, reason: 'not_logged_in' }, 401)
      try {
        const token = await mgmtToken(env)
        const ticketRes = await fetch(
          `https://${env.AUTH0_DOMAIN}/api/v2/guardian/enrollments/ticket`,
          {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify({ user_id: session.sub, send_mail: false }),
          },
        )
        const ticketBody = await ticketRes.text()
        if (!ticketRes.ok) throw new Error(`ticket API ${ticketRes.status}: ${ticketBody}`)
        const ticket = JSON.parse(ticketBody) as { ticket_url?: string }
        if (!ticket.ticket_url) throw new Error(`no ticket_url: ${ticketBody}`)
        return json({ ok: true, ticketUrl: ticket.ticket_url })
      } catch (err) {
        return json({ ok: false, reason: short(err) }, 502)
      }
    }

    // Live Guardian enrollment status - polled by the page during the popup flow
    // and used to render the right phone-panel state.
    if (path.endsWith('/enrollment-status')) {
      if (!session) return json({ ok: false, reason: 'not_logged_in' }, 401)
      const enr = await getEnrollment(env, session.sub)
      return json({ ok: true, enrolled: !!enr, device: enr?.device ?? null })
    }

    // ---- 2c. unenroll: remove the user's Guardian device so they can re-enroll ----
    if (path.endsWith('/unenroll')) {
      if (!session) return json({ ok: false, reason: 'not_logged_in' }, 401)
      try {
        const enr = await getEnrollment(env, session.sub)
        if (enr) {
          const token = await mgmtToken(env)
          await fetch(
            `https://${env.AUTH0_DOMAIN}/api/v2/users/${encodeURIComponent(session.sub)}/authentication-methods/${encodeURIComponent(enr.id)}`,
            { method: 'DELETE', headers: { authorization: `Bearer ${token}` } },
          )
        }
        return json({ ok: true })
      } catch (err) {
        return json({ ok: false, reason: short(err) }, 502)
      }
    }

    // ---- 3a. disconnect: delete the vaulted GitHub account so the next connect re-authorizes
    //          from scratch. Required after changing the GitHub App's granted permissions. ----
    if (path.endsWith('/disconnect') && request.method === 'GET') {
      if (!session) return Response.redirect(`${ORIGIN}/agent/login`, 302)
      try {
        const token = await myAccountToken(env, session.refreshToken)
        const listRes = await fetch(`https://${env.AUTH0_DOMAIN}/me/v1/connected-accounts`, {
          headers: { authorization: `Bearer ${token}` },
        })
        const list = (await listRes.json().catch(() => ({}))) as {
          connected_accounts?: Array<{ id: string; connection: string }>
        }
        for (const acc of list.connected_accounts ?? []) {
          if (acc.connection === 'github' && acc.id) {
            await fetch(`https://${env.AUTH0_DOMAIN}/me/v1/connected-accounts/${acc.id}`, {
              method: 'DELETE',
              headers: { authorization: `Bearer ${token}` },
            })
          }
        }
        session.vaulted = false
        return setSession(env, session, `${ORIGIN}/agent`)
      } catch (err) {
        return new Response(`Disconnect failed: ${String(err)}`, { status: 502 })
      }
    }

    // ---- 3. connect: initiate the Connected Accounts flow to vault the GitHub token ----
    if (path.endsWith('/connect') && request.method === 'GET') {
      if (!session) return Response.redirect(`${ORIGIN}/agent/login`, 302)
      try {
        const token = await myAccountToken(env, session.refreshToken)
        const state = crypto.randomUUID()
        const res = await fetch(`https://${env.AUTH0_DOMAIN}/me/v1/connected-accounts/connect`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({
            connection: 'github',
            redirect_uri: CONNECT_REDIRECT,
            state,
            scopes: ['public_repo'],
          }),
        })
        if (!res.ok) {
          const t = await res.text().catch(() => '')
          return new Response(`Connected Accounts init failed (${res.status}) ${t}`, {
            status: 502,
          })
        }
        const j = (await res.json()) as {
          auth_session?: string
          connect_uri?: string
          connect_params?: { ticket?: string }
        }
        if (!j.auth_session || !j.connect_uri)
          return new Response('Connected Accounts: incomplete connect response', { status: 502 })
        session.authSession = j.auth_session
        session.connectState = state
        const ticket = j.connect_params?.ticket
        const target = ticket
          ? `${j.connect_uri}?ticket=${encodeURIComponent(ticket)}`
          : j.connect_uri
        return setSession(env, session, target)
      } catch (err) {
        return new Response(`Connect failed: ${String(err)}`, { status: 502 })
      }
    }

    // ---- 4. connect/callback: complete the flow → vault the GitHub token in Token Vault ----
    if (path.endsWith('/connect/callback')) {
      if (!session?.authSession) return Response.redirect(`${ORIGIN}/agent`, 302)
      const connectCode = url.searchParams.get('connect_code')
      if (!connectCode) {
        return new Response(connectCodeShim(), {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        })
      }
      const state = url.searchParams.get('state')
      if (state && session.connectState && state !== session.connectState)
        return new Response('state mismatch', { status: 400 })
      try {
        const token = await myAccountToken(env, session.refreshToken)
        const res = await fetch(`https://${env.AUTH0_DOMAIN}/me/v1/connected-accounts/complete`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({
            auth_session: session.authSession,
            connect_code: connectCode,
            redirect_uri: CONNECT_REDIRECT,
          }),
        })
        if (!res.ok) {
          const t = await res.text().catch(() => '')
          return new Response(`Connected Accounts complete failed (${res.status}) ${t}`, {
            status: 502,
          })
        }
        session.vaulted = true
        session.authSession = undefined
        session.connectState = undefined
        return setSession(env, session, `${ORIGIN}/agent`)
      } catch (err) {
        return new Response(`Vaulting failed: ${String(err)}`, { status: 502 })
      }
    }

    // ---- 5. START a durable, multi-step agent session ----
    // The agent reads your GitHub (fresh token), drafts a gist, then PAUSES for
    // out-of-band approval: it emails you a link and hibernates in a Durable
    // Object. When you approve (from your phone, minutes or hours later) the DO
    // wakes and nominee fetches the token AT ACTION TIME - never a stale one.
    if (request.method === 'POST' && path.endsWith('/session/start')) {
      if (!session) return json({ ok: false, reason: 'not_logged_in' }, 401)
      if (!session.vaulted) return json({ ok: false, reason: 'not_connected' }, 403)
      const b = (await request.json().catch(() => ({}))) as {
        topic?: string
        email?: string
        method?: string
      }
      const topic = cleanTopic(b.topic)
      if (!topic) return json({ ok: false, reason: 'invalid_topic' }, 400)
      const method: 'email' | 'ciba' = b.method === 'ciba' ? 'ciba' : 'email'
      const email = (b.email || session.email || '').trim()
      if (method === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
        return json({ ok: false, reason: 'invalid_email' }, 400)

      const ip = request.headers.get('cf-connecting-ip') ?? 'anon'
      if (!(await env.STAR_RL.limit({ key: ip })).success)
        return json({ ok: false, reason: 'rate_limited' }, 429)

      const id = crypto.randomUUID()
      const stub = env.SESSIONS.get(env.SESSIONS.idFromName(id))
      const r = await stub.fetch('https://do/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id,
          user: session.sub,
          name: session.name ?? session.sub,
          email,
          topic,
          method,
          refreshToken: session.refreshToken,
        }),
      })
      const out = (await r.json().catch(() => ({}))) as object
      return json({ ok: r.ok, id, ...out }, r.status)
    }

    // Only the vaulted state needs the live Guardian enrollment status.
    const enrollment = session?.vaulted ? await getEnrollment(env, session.sub) : null
    return new Response(page(session, enrollment), {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    })
  },
}

// =====================================================================
//  Durable Object: one long-running, hibernating agent session.
// =====================================================================

type StepKind = 'started' | 'gather' | 'draft' | 'paused' | 'resumed' | 'token' | 'acted' | 'error'
interface Step {
  kind: StepKind
  at: number
  text: string
}
interface SessionState {
  id: string
  user: string
  name: string
  email: string
  topic: string
  refreshToken: string
  approvalKey: string
  status: 'awaiting_approval' | 'approved' | 'denied' | 'done' | 'error'
  method: 'email' | 'ciba'
  cibaReqId?: string
  steps: Step[]
  startedAt: number
  pausedAt?: number
  resumedAt?: number
  // GitHub context the agent gathered (real):
  ghLogin?: string
  ghRepos?: string[]
  // Proof of call-time token acquisition:
  tokenAt?: number
  tokenFp?: string
  gistUrl?: string
  audit: Array<{ type: string; at: number }>
}

export class AgentSession {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)
    if (url.pathname === '/start') return this.start(req)
    if (url.pathname === '/state') return this.getState()
    if (url.pathname === '/resolve') {
      const decision = url.searchParams.get('decision') === 'approved' ? 'approved' : 'denied'
      const k = url.searchParams.get('k') ?? ''
      return this.resolve(decision, k)
    }
    return new Response('not found', { status: 404 })
  }

  private async load(): Promise<SessionState | null> {
    return (await this.state.storage.get<SessionState>('s')) ?? null
  }
  private async save(s: SessionState) {
    await this.state.storage.put('s', s)
  }

  /** Build a nominee bound to THIS session's vaulted user. The refresh token is
   *  read from durable storage at call time - so it survives hibernation. */
  private nominee(s: SessionState, audit: SessionState['audit']) {
    return new Nominee({
      strategy: Auth0({
        domain: this.env.AUTH0_DOMAIN,
        clientId: this.env.AUTH0_CLIENT_ID,
        clientSecret: this.env.AUTH0_CLIENT_SECRET,
        subjectToken: () => s.refreshToken,
        subjectTokenType: 'refresh_token',
      }),
      onAudit: (e) => audit.push({ type: e.type, at: e.at }),
      agent: 'github-agent',
    })
  }

  /** Phase 1: plan, read the user's real GitHub, draft, then PAUSE for approval. */
  private async start(req: Request): Promise<Response> {
    const init = (await req.json()) as {
      id: string
      user: string
      name: string
      email: string
      topic: string
      method: 'email' | 'ciba'
      refreshToken: string
    }
    const now = Date.now()
    const audit: SessionState['audit'] = []
    const s: SessionState = {
      ...init,
      approvalKey: crypto.randomUUID(),
      status: 'awaiting_approval',
      method: init.method ?? 'email',
      steps: [{ kind: 'started', at: now, text: `agent session started - "${init.topic}"` }],
      startedAt: now,
      audit,
    }

    // Real step: fetch the user's GitHub profile + recent repos with a fresh
    // nominee token (proves the read path works on the user's real account).
    try {
      const nominee = this.nominee(s, audit)
      const token = await nominee.token({ user: s.user, connection: 'github' })
      const [profile, repos] = await Promise.all([
        ghGet<{ login?: string }>(token, 'https://api.github.com/user'),
        ghGet<Array<{ name: string }>>(
          token,
          'https://api.github.com/user/repos?sort=updated&per_page=3',
        ),
      ])
      s.ghLogin = profile?.login
      s.ghRepos = (repos ?? []).map((r) => r.name).slice(0, 3)
      s.steps.push({
        kind: 'gather',
        at: Date.now(),
        text: s.ghLogin
          ? `read your GitHub: @${s.ghLogin}${s.ghRepos?.length ? ` · recent repos: ${s.ghRepos.join(', ')}` : ''}`
          : 'read your GitHub profile',
      })
    } catch (err) {
      s.steps.push({ kind: 'gather', at: Date.now(), text: `GitHub read skipped (${short(err)})` })
    }

    s.steps.push({
      kind: 'draft',
      at: Date.now(),
      text: 'drafted a gist summarizing this session - needs your approval to publish',
    })
    s.pausedAt = Date.now()
    s.steps.push({
      kind: 'paused',
      at: s.pausedAt,
      text:
        s.method === 'ciba'
          ? 'paused - Auth0 Guardian push sent. Agent is hibernating; it will wake when you approve on your phone.'
          : `paused - approval link emailed to ${s.email}. Agent is hibernating; it will resume when you approve.`,
    })

    await this.save(s)

    if (s.method === 'ciba') {
      await this.initiateCiba(s)
    } else {
      // Send the out-of-band approval email. The agent now does NOTHING until the
      // link is clicked - no compute, no polling, just durable state.
      await this.sendApprovalEmail(s)
    }

    return json({ status: s.status })
  }

  /** Phase 2 (email path): woken by the email link click. */
  private async resolve(decision: 'approved' | 'denied', k: string): Promise<Response> {
    const s = await this.load()
    if (!s) return json({ ok: false, reason: 'unknown_session' }, 404)
    if (s.status === 'done' || s.status === 'denied')
      return json({ ok: s.status === 'done', already: true, gistUrl: s.gistUrl }, 200)
    if (s.method === 'ciba') return json({ ok: false, reason: 'ciba_session' }, 400)
    if (k !== s.approvalKey) return json({ ok: false, reason: 'bad_key' }, 403)

    s.resumedAt = Date.now()
    s.steps.push({
      kind: 'resumed',
      at: s.resumedAt,
      text: `you ${decision} from your inbox - agent woke after ${humanGap(s.pausedAt, s.resumedAt)} of hibernation`,
    })

    if (decision === 'denied') {
      s.status = 'denied'
      await this.save(s)
      return json({ ok: false, decision })
    }

    const ok = await this.act(s)
    if (ok) return json({ ok: true, decision, gistUrl: s.gistUrl })
    return json({ ok: false, reason: 'action_failed' }, 502)
  }

  /** Fetch a fresh token and publish the gist. Mutates and saves s. Returns true on success. */
  private async act(s: SessionState): Promise<boolean> {
    try {
      const nominee = this.nominee(s, s.audit)
      // The whole point: ask for the token NOW, at action time. If the session
      // had slept past the token's life, this transparently refreshes.
      const token = await nominee.token({ user: s.user, connection: 'github' })
      s.tokenAt = Date.now()
      s.tokenFp = fingerprint(token)
      s.steps.push({
        kind: 'token',
        at: s.tokenAt,
        text: `nominee fetched a fresh GitHub token from Auth0 Token Vault at action time (…${s.tokenFp})`,
      })

      const gist = await ghPost(token, 'https://api.github.com/gists', {
        description: `Agent session: ${s.topic} - published via nominee + Auth0 Token Vault`,
        // Secret (private) gist: a real write to the visitor's account, gated by
        // CIBA approval, but never publicly visible — minimal anxiety for a demo
        // a stranger connects their GitHub to.
        public: false,
        files: { 'agent-session.md': { content: gistBody(s) } },
      })
      if (!gist.ok) {
        s.status = 'error'
        s.steps.push({ kind: 'error', at: Date.now(), text: `publish failed (${gist.status})` })
      } else {
        s.gistUrl = gist.url
        s.status = 'done'
        s.steps.push({ kind: 'acted', at: Date.now(), text: 'published a gist to your GitHub' })
      }
    } catch (err) {
      s.status = 'error'
      s.steps.push({ kind: 'error', at: Date.now(), text: short(err) })
    }
    await this.save(s)
    return s.status === 'done'
  }

  /** Initiate a CIBA bc-authorize request and arm the first poll alarm. */
  private async initiateCiba(s: SessionState): Promise<void> {
    try {
      const msg = `Approve: publish a gist - ${s.topic.slice(0, 50)}`
      const authRes = await fetch(`https://${this.env.AUTH0_DOMAIN}/bc-authorize`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: new URLSearchParams({
          client_id: this.env.AUTH0_CLIENT_ID,
          client_secret: this.env.AUTH0_CLIENT_SECRET,
          scope: 'openid',
          login_hint: JSON.stringify({
            format: 'iss_sub',
            iss: `https://${this.env.AUTH0_DOMAIN}/`,
            sub: s.user,
          }),
          binding_message: msg,
        }),
      })
      if (!authRes.ok) {
        const text = await authRes.text().catch(() => '')
        throw new Error(`bc-authorize failed (${authRes.status}) ${text}`)
      }
      const auth = (await authRes.json()) as {
        auth_req_id: string
        expires_in?: number
        interval?: number
      }
      s.cibaReqId = auth.auth_req_id
      await this.save(s)
      await this.state.storage.setAlarm(Date.now() + (auth.interval ?? 5) * 1000)
    } catch (err) {
      s.steps.push({ kind: 'error', at: Date.now(), text: `CIBA initiation failed: ${short(err)}` })
      s.status = 'error'
      await this.save(s)
    }
  }

  /** Phase 2 (CIBA path): called by the Cloudflare runtime on each alarm tick.
   *  Polls Auth0 once; re-arms if pending, resolves and acts if approved. */
  async alarm(): Promise<void> {
    const s = await this.load()
    if (!s || s.method !== 'ciba' || !s.cibaReqId || s.status !== 'awaiting_approval') return

    try {
      const pollRes = await fetch(`https://${this.env.AUTH0_DOMAIN}/oauth/token`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: new URLSearchParams({
          grant_type: 'urn:openid:params:grant-type:ciba',
          auth_req_id: s.cibaReqId,
          client_id: this.env.AUTH0_CLIENT_ID,
          client_secret: this.env.AUTH0_CLIENT_SECRET,
        }),
      })

      if (pollRes.ok) {
        s.resumedAt = Date.now()
        s.steps.push({
          kind: 'resumed',
          at: s.resumedAt,
          text: `you approved via Auth0 Guardian - agent woke after ${humanGap(s.pausedAt, s.resumedAt)} of hibernation`,
        })
        await this.act(s)
        return
      }

      const err = (await pollRes.json().catch(() => ({}))) as { error?: string }
      if (err.error === 'authorization_pending' || err.error === 'slow_down') {
        await this.state.storage.setAlarm(Date.now() + 5000)
        return
      }
      if (err.error === 'access_denied') {
        s.resumedAt = Date.now()
        s.status = 'denied'
        s.steps.push({
          kind: 'resumed',
          at: s.resumedAt,
          text: 'you denied via Auth0 Guardian - agent stayed paused and took no action',
        })
        await this.save(s)
        return
      }
      if (err.error === 'expired_token') {
        s.status = 'error'
        s.steps.push({
          kind: 'error',
          at: Date.now(),
          text: 'CIBA request expired - Guardian notification went unanswered',
        })
        await this.save(s)
        return
      }
      // Unknown error: retry
      await this.state.storage.setAlarm(Date.now() + 5000)
    } catch {
      await this.state.storage.setAlarm(Date.now() + 5000)
    }
  }

  private async getState(): Promise<Response> {
    const s = await this.load()
    if (!s) return json({ ok: false, reason: 'unknown_session' }, 404)
    // Never expose the refresh token or approval key to the polling UI.
    const { refreshToken: _r, approvalKey: _k, ...safe } = s
    return json({ ok: true, ...safe })
  }

  private async sendApprovalEmail(s: SessionState) {
    const base = `${ORIGIN}/agent`
    const approve = `${base}/approve?id=${s.id}&k=${s.approvalKey}`
    const deny = `${base}/deny?id=${s.id}&k=${s.approvalKey}`
    try {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.env.RESEND_API_KEY}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          from: this.env.FROM,
          to: [s.email],
          subject: 'Approve: your agent wants to publish a gist',
          html: approvalEmail(s, approve, deny),
        }),
      })
    } catch {
      // Non-fatal: the console still shows the pending state; email is best-effort.
    }
  }
}

// ---- small helpers ----
async function ghGet<T>(token: string, urlStr: string): Promise<T | null> {
  const r = await fetch(urlStr, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'nominee-demo',
    },
  })
  return r.ok ? ((await r.json()) as T) : null
}
async function ghPost(token: string, urlStr: string, body: object) {
  const r = await fetch(urlStr, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'nominee-demo',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  const j = (await r.json().catch(() => ({}))) as { html_url?: string }
  return { ok: r.ok, status: r.status, url: j.html_url }
}
const fingerprint = (t: string) => t.slice(-6).replace(/[^a-zA-Z0-9]/g, 'x')
const short = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 140)
function humanGap(from?: number, to?: number): string {
  if (!from || !to) return 'a moment'
  const s = Math.max(0, Math.round((to - from) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`
}
function gistBody(s: SessionState): string {
  const who = s.ghLogin ? `@${s.ghLogin}` : s.name
  const repos = s.ghRepos?.length ? `Recent repos reviewed: ${s.ghRepos.join(', ')}.\n\n` : ''
  const channel = s.method === 'ciba' ? 'a push notification to their phone' : 'an email link'
  return `# Agent session: ${s.topic}\n\nThis gist was published by an autonomous agent acting for ${who}, after ${who} approved it via ${channel}.\n\n${repos}The agent paused and **hibernated** while waiting for approval. When approval arrived, **nominee** fetched a fresh, short-lived GitHub token from **Auth0 Token Vault** at the moment of the action - it never held a captured token across the pause. The agent never saw a password.\n\nvia https://nominee.dev\n`
}

async function getSession(req: Request, env: Env): Promise<Session | null> {
  const c = getCookie(req, COOKIE)
  return c ? unseal<Session>(env.SESSION_SECRET, c) : null
}
function decodeJwt(jwt: string): {
  sub?: string
  name?: string
  nickname?: string
  email?: string
} {
  try {
    return JSON.parse(
      new TextDecoder().decode(ub64(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))),
    )
  } catch {
    return {}
  }
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[m] as string)

function approvalEmail(s: SessionState, approve: string, deny: string): string {
  const who = s.ghLogin ? `@${s.ghLogin}` : escapeHtml(s.name)
  return `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:480px;margin:0 auto;color:#0a1020">
  <p style="font-family:ui-monospace,monospace;font-size:12px;letter-spacing:.15em;text-transform:uppercase;color:#8c2f2a">nominee · approval required</p>
  <h2 style="font-size:20px;margin:8px 0 4px">Your agent paused for you, ${who}.</h2>
  <p style="color:#444;line-height:1.5">An autonomous agent wants to <b>publish a gist on your GitHub</b>:</p>
  <p style="background:#f4f4f5;border-radius:8px;padding:12px 14px;color:#222;font-size:15px">${escapeHtml(s.topic)}</p>
  <p style="color:#444;line-height:1.5;font-size:14px">It's <b>hibernating</b> until you decide. Approve and it resumes - nominee fetches a fresh token from Auth0 Token Vault <i>at that moment</i>, never a stale one.</p>
  <div style="margin:24px 0">
    <a href="${approve}" style="background:#0a1020;color:#fff;font-weight:600;text-decoration:none;padding:13px 22px;border-radius:9px;display:inline-block;margin-right:10px">✓ Approve &amp; publish</a>
    <a href="${deny}" style="color:#666;text-decoration:none;padding:13px 18px;border-radius:9px;border:1px solid #ddd;display:inline-block">Deny</a>
  </div>
  <p style="color:#999;font-size:12px;line-height:1.5">You're receiving this because you started a session at nominee.dev/agent. The agent never saw your password or a stored token.</p>
</div>`
}

function approvalLandingPage(
  decision: string,
  out: { ok?: boolean; gistUrl?: string },
  id: string,
): string {
  const ok = decision === 'approved' && out.ok
  const head = ok
    ? '✓ Approved - your agent resumed'
    : decision === 'denied'
      ? 'Denied - nothing was published'
      : 'Could not complete'
  const body = ok
    ? `nominee fetched a fresh GitHub token from Token Vault at action time and the agent published your gist.${out.gistUrl ? ` <a href="${escapeHtml(out.gistUrl)}" style="color:#8c2f2a">View it ↗</a>` : ''}`
    : decision === 'denied'
      ? 'The agent stayed paused and took no action on your account.'
      : 'This approval link may have already been used, or the session expired.'
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>nominee · ${escapeHtml(head)}</title>
<style>body{font-family:'Geist',system-ui,-apple-system,sans-serif;background:radial-gradient(800px 400px at 50% -20%,rgba(140,47,42,.05),transparent 60%),#fff;color:#0a1020;min-height:100vh;display:grid;place-items:center;margin:0;padding:24px;-webkit-font-smoothing:antialiased}
.card{max-width:440px;text-align:center;background:#fbfbfc;border:1px solid #e5e7ee;border-radius:16px;padding:40px 28px;box-shadow:0 1px 2px rgba(10,16,32,.04),0 24px 60px -42px rgba(10,16,32,.3)}
h1{font-size:24px;margin:0 0 12px;letter-spacing:-.025em}p{color:#38414f;line-height:1.6}a{color:#8c2f2a}
.back{font-family:ui-monospace,monospace;font-size:13px;color:#6b7488;margin-top:24px;display:inline-block;border-bottom:1px solid #e5e7ee;padding-bottom:2px}</style></head>
<body><div class="card"><h1>${escapeHtml(head)}</h1><p>${body}</p>
<a class="back" href="${ORIGIN}/agent/session-view?id=${escapeHtml(id)}">watch the full session timeline →</a></div></body></html>`
}

// The six visible stages of an agent run. This list is the single source of
// truth for both the static preview (server-rendered) and the live timeline
// (client-rendered) - so the diagram a visitor sees up front is exactly the
// thing that lights up as the real session runs.
const STAGES = [
  { key: 'gather', glyph: '◎', label: 'Reads your GitHub' },
  { key: 'draft', glyph: '✎', label: 'Drafts a gist' },
  { key: 'paused', glyph: '⏸', label: 'Pauses for your approval' },
  { key: 'resumed', glyph: '✓', label: 'You approve' },
  { key: 'token', glyph: '↻', label: 'Fresh token, minted live' },
  { key: 'acted', glyph: '↗', label: 'Publishes to GitHub' },
] as const

// Static preview of the flow - all stages pending. Shown before a run starts
// (and to logged-out visitors) so the concept reads at a glance, no text wall.
function flowStatic(): string {
  const nodes = STAGES.map(
    (s) =>
      `<div class="fnode is-pending"><div class="fnode-mark"><span>${s.glyph}</span></div><div class="fnode-main"><div class="fnode-label">${s.label}</div></div></div>`,
  ).join('')
  return `<div class="flow">${nodes}</div>`
}

function monogram(name: string): string {
  const c = name.trim()[0]
  return escapeHtml((c || 'Y').toUpperCase())
}

const ICON_MAIL =
  '<svg class="seg-ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2" y="3.5" width="12" height="9" rx="1.5"/><path d="m2.5 4.5 5.5 4 5.5-4"/></svg>'
const ICON_PHONE =
  '<svg class="seg-ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="4.5" y="1.5" width="7" height="13" rx="1.6"/><path d="M7 12.2h2"/></svg>'

function page(session: Session | null, enrollment: Enrollment | null) {
  const name = session?.name || session?.sub || 'you'
  const who = escapeHtml(name)

  // State 1 of 3: not logged in. Sell the concept with the visual, not prose.
  const loggedOut = `
    <div class="solo">
      <h1 class="hero-h1">Watch an agent pause for your approval.</h1>
      <p class="hero-sub">It reads your GitHub and drafts a gist, then waits for your yes - by email or phone - and acts with a token minted at that exact moment.</p>
      <div class="card flow-card">${flowStatic()}</div>
      <a class="primary big" href="/agent/login">Connect GitHub to start →</a>
      <p class="trust">One real OAuth login. The agent never sees your password or stores a token.</p>
    </div>`

  // State 2 of 3: logged in, GitHub not yet vaulted.
  const needVault = `
    <div class="solo">
      <h1 class="hero-h1">One step left, ${who}.</h1>
      <p class="hero-sub">Vault your GitHub token in Auth0 Token Vault so nominee can mint a fresh one for each action. Revoke any time.</p>
      <div class="card flow-card">${flowStatic()}</div>
      <a class="primary big" href="/agent/connect">Vault GitHub token →</a>
      <p class="trust"><a href="/agent/logout">Not you? Log out</a></p>
    </div>`

  // Phone panel: two views, toggled live by the popup-enrollment flow.
  const enrolledView = `
        <div class="device">
          <span class="device-ic">✓</span>
          <div class="device-body">
            <p class="device-name">Guardian ready on <span id="ciba-device">${escapeHtml(enrollment?.device || 'your phone')}</span></p>
            <p class="hint">The agent pushes an approval request straight to this phone.</p>
          </div>
          <button type="button" class="device-remove" id="ciba-remove">Remove</button>
        </div>`
  const setupView = `
        <div class="setup">
          <p class="setup-lede">Approve from your phone with the free <strong>Auth0 Guardian</strong> app. Scan once, right here - no leaving the page.</p>
          <div class="setup-row">
            <button type="button" class="primary sm" id="ciba-enroll">Set up Guardian</button>
            <span class="setup-status" id="ciba-setup-status"></span>
          </div>
          <details class="needapp">
            <summary>Don't have the app?</summary>
            <div class="qr-row">
              <div class="qr-item">
                <img src="https://api.qrserver.com/v1/create-qr-code/?size=92x92&data=https%3A%2F%2Fapps.apple.com%2Fus%2Fapp%2Fauth0-guardian%2Fid1093447833" width="92" height="92" alt="App Store QR code" class="qr-img" />
                <a href="https://apps.apple.com/us/app/auth0-guardian/id1093447833" target="_blank" rel="noopener" class="store-btn">App Store</a>
              </div>
              <div class="qr-item">
                <img src="https://api.qrserver.com/v1/create-qr-code/?size=92x92&data=https%3A%2F%2Fplay.google.com%2Fstore%2Fapps%2Fdetails%3Fid%3Dcom.auth0.guardian" width="92" height="92" alt="Google Play QR code" class="qr-img" />
                <a href="https://play.google.com/store/apps/details?id=com.auth0.guardian" target="_blank" rel="noopener" class="store-btn">Google Play</a>
              </div>
            </div>
          </details>
        </div>`

  // State 3 of 3: connected and vaulted - the playground.
  const ready = `
    <div class="hero">
      <h1 class="hero-h1">Run an agent that waits for your approval.</h1>
      <p class="hero-sub">Reads your GitHub. Pauses for your yes. Acts with a token minted the moment you approve.</p>
    </div>
    <div class="play" id="starter" data-method="email" data-enrolled="${enrollment ? '1' : '0'}">
      <div class="card play-control">
        <div class="ident">
          <span class="ident-dot">${monogram(name)}</span>
          <span class="ident-name">${who}</span>
          <span class="ident-links"><a href="/agent/disconnect">re-vault</a> · <a href="/agent/logout">log out</a></span>
        </div>
        <label for="topic">Task</label>
        <input id="topic" type="text" value="Summary of my recent GitHub activity" maxlength="140" />

        <label style="margin-top:18px">Approve via</label>
        <div class="seg" id="seg" role="tablist">
          <span class="seg-ind" id="seg-ind"></span>
          <button type="button" class="seg-opt active" data-method="email" role="tab">${ICON_MAIL} Email link</button>
          <button type="button" class="seg-opt" data-method="ciba" role="tab">${ICON_PHONE} Phone push</button>
        </div>

        <div class="panel" id="panel-email">
          <label for="email">Send approval link to</label>
          <input id="email" type="email" value="${escapeHtml(session?.email || '')}" placeholder="you@example.com" />
          <p class="hint">A one-click approve / deny link. The agent hibernates until you click.</p>
        </div>

        <div class="panel" id="panel-ciba" hidden>
          <div id="ciba-enrolled" ${enrollment ? '' : 'hidden'}>${enrolledView}</div>
          <div id="ciba-setup" ${enrollment ? 'hidden' : ''}>${setupView}</div>
        </div>

        <div class="row">
          <button id="run" class="primary">Start session ▸</button>
          <button id="again" class="ghost" hidden>Run again</button>
          <span id="status" class="status"></span>
        </div>
      </div>

      <div class="card play-flow">
        <div class="flow-head"><span class="flow-title">Agent run</span><span class="tl-clock" id="clock" hidden></span></div>
        <div id="flow-banner"></div>
        <div id="flowbox">${flowStatic()}</div>
        <div id="flow-extra"></div>
      </div>
    </div>`

  const isReady = !!session && !!session.vaulted
  return html(!session ? loggedOut : isReady ? ready : needVault, isReady)
}

// Tiny shim: if Auth0 returned connect_code in the URL fragment (not sent to the
// server), extract it client-side and re-request this route with it as a query param.
function connectCodeShim() {
  return `<!doctype html><html><head><meta charset="utf-8"><title>completing…</title></head><body>
<script>
const m=location.hash.match(/connect_code=([^&]+)/)||location.search.match(/connect_code=([^&]+)/);
if(m){location.replace('/agent/connect/callback?connect_code='+encodeURIComponent(m[1]));}
else{document.body.textContent='Missing connect_code - please reconnect.';}
</script></body></html>`
}

function html(inner: string, loggedIn: boolean) {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" />
<title>nominee · live agent session</title>
<link rel="icon" href="${ORIGIN}/assets/icon.svg" type="image/svg+xml" />
<link rel="preconnect" href="https://fonts.googleapis.com" /><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Schibsted+Grotesk:wght@400;500;600&family=Geist+Mono:wght@400;500&display=swap" rel="stylesheet" />
<style>
:root{--bg:#faf9f5;--surface:#ffffff;--surface-2:#f2f0e8;--ink:#0a1020;--ink-soft:#3a4154;--muted:#71798c;--line:#e7e3d8;--seal:#8c2f2a;--seal-tint:rgba(140,47,42,.08);--navy:#0b1020;--navy-hover:#1b2438;--ok:#1f6b4a;--err:#cf3520;--code-bg:#0b1226;--code-text:#cdd5e6;--sans:'Schibsted Grotesk',ui-sans-serif,system-ui,sans-serif;--mono:'Geist Mono',ui-monospace,monospace}
*{margin:0;box-sizing:border-box}[hidden]{display:none!important}body{font-family:var(--sans);background:radial-gradient(1100px 540px at 85% -14%,rgba(140,47,42,.05),transparent 60%),var(--bg);color:var(--ink);min-height:100vh;line-height:1.55;-webkit-font-smoothing:antialiased}
a{color:inherit;text-decoration:none}
.bar{display:flex;align-items:center;justify-content:space-between;padding:16px clamp(18px,4vw,40px);border-bottom:1px solid var(--line);position:sticky;top:0;background:rgba(255,255,255,.82);backdrop-filter:blur(10px);z-index:5}
.bar .brand{display:flex;align-items:center;gap:9px;font-weight:600;letter-spacing:-.02em}
.bar .brand svg{width:24px;height:24px;color:var(--seal)}
.tag{font-family:var(--mono);font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);border:1px solid var(--line);border-radius:999px;padding:5px 11px}
.wrap{max-width:1040px;margin:0 auto;padding:clamp(30px,5vw,56px) 22px 72px}
.solo{max-width:560px;margin:0 auto;text-align:center}
.hero{margin-bottom:26px}
.hero-h1{font-size:clamp(27px,4vw,38px);letter-spacing:-.035em;font-weight:600;line-height:1.08;margin-bottom:12px}
.solo .hero-h1{margin-left:auto;margin-right:auto;max-width:16ch}
.hero-sub{color:var(--ink-soft);font-size:16px;line-height:1.55;max-width:50ch}
.solo .hero-sub{margin:0 auto 26px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:22px;box-shadow:0 1px 2px rgba(10,16,32,.04),0 20px 46px -36px rgba(10,16,32,.3)}
.flow-card{margin-bottom:24px;text-align:left}
.primary.big{font-size:15px;padding:15px 26px}
.trust{font-family:var(--mono);font-size:12px;color:var(--muted);margin-top:18px}.trust a{color:var(--muted);border-bottom:1px solid var(--line)}
label{font-family:var(--mono);font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);display:block;margin-bottom:8px}
input{width:100%;font-family:var(--mono);font-size:15px;color:var(--ink);background:#fff;border:1px solid var(--line);border-radius:9px;padding:13px 14px;transition:.15s}input:focus{outline:none;border-color:var(--seal);box-shadow:0 0 0 3px var(--seal-tint)}
.row{display:flex;gap:10px;flex-wrap:wrap;margin-top:18px;align-items:center}
button{font-family:var(--mono);font-size:14px;cursor:pointer;border-radius:9px;padding:13px 20px;border:1px solid var(--line);background:#fff;color:var(--ink);transition:.18s ease;display:inline-flex;align-items:center;gap:8px}
a.primary{font-family:var(--mono);font-size:14px;border-radius:9px;padding:13px 20px;display:inline-block;transition:.18s ease}
button:hover{border-color:#d2d6e0}button:active{transform:translateY(1px)}
.primary{background:var(--navy);color:#fff;border-color:var(--navy);font-weight:600}.primary:hover{background:var(--navy-hover);border-color:var(--navy-hover)}
.ghost{background:#fff;color:var(--ink-soft)}
button:disabled{opacity:.45;cursor:default;transform:none}
.hint{font-size:13px;color:var(--muted);line-height:1.5;margin:8px 0 0}
.status{font-family:var(--mono);font-size:13px;color:var(--muted)}.status.err{color:var(--err)}
.primary.sm{padding:10px 16px;font-size:13px}
/* playground grid */
.play{display:grid;grid-template-columns:minmax(330px,400px) 1fr;gap:22px;align-items:start}
.play-control{padding:22px}
.play-flow{padding:22px;min-height:340px}
@media(max-width:780px){.play{grid-template-columns:1fr}}
/* identity chip */
.ident{display:flex;align-items:center;gap:9px;margin-bottom:20px}
.ident-dot{flex:none;width:26px;height:26px;border-radius:50%;background:var(--navy);color:#fff;font-size:12px;font-weight:600;display:flex;align-items:center;justify-content:center}
.ident-name{font-weight:600;font-size:14px;letter-spacing:-.01em}
.ident-links{margin-left:auto;font-family:var(--mono);font-size:11px;color:var(--muted)}.ident-links a{border-bottom:1px solid var(--line)}.ident-links a:hover{color:var(--ink)}
/* segmented control with sliding indicator */
.seg{position:relative;display:grid;grid-template-columns:1fr 1fr;gap:4px;padding:4px;background:var(--surface-2);border:1px solid var(--line);border-radius:11px}
.seg-ind{position:absolute;top:4px;height:calc(100% - 8px);background:#fff;border:1px solid var(--line);border-radius:8px;box-shadow:0 1px 2px rgba(10,16,32,.08);transition:left .24s cubic-bezier(.4,0,.2,1),width .24s cubic-bezier(.4,0,.2,1);z-index:0}
.seg-opt{position:relative;z-index:1;justify-content:center;font-family:var(--mono);font-size:13px;font-weight:500;color:var(--muted);background:transparent;border:none;border-radius:8px;padding:10px;transition:color .18s}
.seg-opt:hover{color:var(--ink-soft);border:none}
.seg-opt.active{color:var(--ink)}
.seg-ic{width:15px;height:15px;flex:none}
.panel{margin-top:16px}
/* enrolled device row */
.device{display:flex;align-items:flex-start;gap:12px;background:rgba(31,107,74,.05);border:1px solid rgba(31,107,74,.22);border-radius:11px;padding:14px 16px;animation:fade .3s ease}
.device-ic{flex:none;width:24px;height:24px;border-radius:50%;background:var(--ok);color:#fff;font-size:13px;font-weight:700;display:flex;align-items:center;justify-content:center;margin-top:1px}
.device-body{flex:1}.device-name{font-size:14px;font-weight:600;color:var(--ink);margin:0}
.device-remove{font-family:var(--mono);font-size:11.5px;color:var(--muted);background:none;border:none;border-bottom:1px solid var(--line);border-radius:0;padding:0 0 1px;white-space:nowrap;margin-top:3px}.device-remove:hover{color:var(--err);border-color:var(--err)}
/* not-enrolled setup */
.setup{background:var(--seal-tint);border:1px solid rgba(140,47,42,.22);border-radius:11px;padding:16px 18px;animation:fade .3s ease}
.setup-lede{font-size:14px;color:var(--ink-soft);line-height:1.55;margin:0 0 14px}.setup-lede strong{color:var(--ink)}
.setup-row{display:flex;align-items:center;gap:12px}
.setup-status{font-family:var(--mono);font-size:12px;color:var(--seal)}
.needapp{margin-top:14px}.needapp summary{font-family:var(--mono);font-size:12px;color:var(--muted);cursor:pointer;list-style:none}.needapp summary::-webkit-details-marker{display:none}.needapp summary:before{content:'+ ';color:var(--seal)}.needapp[open] summary:before{content:'− '}
.qr-row{display:flex;gap:14px;margin-top:12px}.qr-item{display:flex;flex-direction:column;align-items:center;gap:6px}.qr-img{border-radius:6px;border:1px solid var(--line);display:block;background:#fff}
.store-btn{font-family:var(--mono);font-size:11px;padding:5px 12px;border-radius:6px;background:#fff;border:1px solid var(--line);color:var(--ink);text-align:center;width:100%}.store-btn:hover{border-color:#d2d6e0}
/* flow stepper */
.flow-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:14px}
.flow-title{font-family:var(--mono);font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted)}
.tl-clock{font-family:var(--mono);font-size:12px;color:var(--seal);background:var(--seal-tint);border:1px solid rgba(140,47,42,.25);border-radius:999px;padding:4px 11px;white-space:nowrap}
.flow{position:relative}
.fnode{position:relative;display:grid;grid-template-columns:28px 1fr auto;gap:13px;align-items:start;padding:9px 0}
.fnode:not(:last-child)::before{content:'';position:absolute;left:13px;top:28px;bottom:-9px;width:2px;transform:translateX(-50%);background:var(--line);transition:background .4s}
.fnode.is-done::before{background:var(--ok)}
.fnode.is-wait::before{background:repeating-linear-gradient(var(--seal) 0 4px,transparent 4px 8px)}
.fnode-mark{position:relative;z-index:1;width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:13px;background:var(--surface);border:1.5px solid var(--line);color:var(--muted);transition:all .3s ease}
.fnode-main{padding-top:3px}
.fnode-label{font-size:14px;color:var(--ink);font-weight:500;line-height:1.35}
.fnode-detail{font-family:var(--mono);font-size:11.5px;color:var(--muted);margin-top:3px;word-break:break-word}
.fnode-detail a{color:var(--seal);border-bottom:1px solid rgba(140,47,42,.3)}
.fnode-ts{font-family:var(--mono);font-size:11px;color:var(--muted);padding-top:5px}
.fnode.is-pending .fnode-mark{opacity:.55}.fnode.is-pending .fnode-label{color:var(--muted);font-weight:400}
.fnode.is-done .fnode-mark{background:var(--ok);border-color:var(--ok);color:#fff;animation:pop .34s ease}
.fnode.is-wait .fnode-mark{background:var(--seal-tint);border-color:var(--seal);color:var(--seal);animation:ring 1.7s infinite}
.fnode.is-wait .fnode-label{color:var(--seal)}
.fnode.is-denied .fnode-mark,.fnode.is-error .fnode-mark{background:var(--err);border-color:var(--err);color:#fff;animation:pop .34s ease}
.play-flow.win{animation:glow 1.1s ease}
.flow-extra{margin-top:6px}
.gist-link{display:inline-flex;align-items:center;gap:7px;font-family:var(--mono);font-size:13px;color:var(--seal);margin-top:14px;border:1px solid rgba(140,47,42,.3);border-radius:8px;padding:9px 13px;transition:.15s}.gist-link:hover{background:var(--seal-tint)}
.jsontoggle{font-family:var(--mono);font-size:12px;color:var(--muted);background:none;border:none;border-bottom:1px solid var(--line);border-radius:0;padding:0 0 2px;margin-top:16px;cursor:pointer}
pre{font-family:var(--mono);font-size:12px;color:var(--code-text);background:var(--code-bg);border:1px solid var(--line);border-radius:10px;padding:14px;overflow:auto;margin-top:10px}
.banner{font-family:var(--mono);font-size:12.5px;border-radius:10px;padding:12px 14px;margin-bottom:16px;animation:fade .3s ease}
.banner.wait{background:var(--seal-tint);border:1px solid rgba(140,47,42,.28);color:var(--seal)}
.banner.ok{background:rgba(31,107,74,.07);border:1px solid rgba(31,107,74,.25);color:var(--ok)}
.banner.er{background:rgba(207,53,32,.06);border:1px solid rgba(207,53,32,.25);color:var(--err)}
.foot{font-family:var(--mono);font-size:12px;color:var(--muted)}
@keyframes pop{0%{transform:scale(.5)}55%{transform:scale(1.14)}100%{transform:scale(1)}}
@keyframes ring{0%{box-shadow:0 0 0 0 rgba(140,47,42,.34)}70%{box-shadow:0 0 0 8px rgba(140,47,42,0)}100%{box-shadow:0 0 0 0 rgba(140,47,42,0)}}
@keyframes fade{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
@keyframes glow{0%,100%{box-shadow:0 1px 2px rgba(10,16,32,.04),0 20px 46px -36px rgba(10,16,32,.3)}40%{box-shadow:0 0 0 3px rgba(31,107,74,.18),0 20px 46px -30px rgba(31,107,74,.4)}}
:focus-visible{outline:2px solid var(--seal);outline-offset:2px}
@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
</style></head><body>
<div class="bar"><a class="brand" href="${ORIGIN}"><svg viewBox="0 0 40 40" fill="none" stroke="currentColor" stroke-width="1"><circle cx="20" cy="20" r="15"/><circle cx="20" cy="20" r="11" stroke-opacity=".5"/><ellipse cx="20" cy="20" rx="15" ry="5" stroke-opacity=".5"/><ellipse cx="20" cy="20" rx="15" ry="5" stroke-opacity=".5" transform="rotate(60 20 20)"/><ellipse cx="20" cy="20" rx="15" ry="5" stroke-opacity=".5" transform="rotate(120 20 20)"/></svg><span>nominee</span></a><span class="tag">live testbed</span></div>
<div class="wrap">
${inner}
<p class="foot" style="margin-top:32px;text-align:center"><a href="${ORIGIN}" style="color:var(--muted)">← nominee.dev</a> · <a href="https://github.com/bharath31/nominee" style="color:var(--muted)">source ↗</a></p>
</div>
${loggedIn ? script() : viewerScript()}
</body></html>`
}

// Shared client helpers: the flow renderer + formatters used by both the live
// playground and the read-only session viewer.
function flowJs(): string {
  return `
const STAGES=${JSON.stringify(STAGES)};
function esc(s){return String(s).replace(/[&<>]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[m]))}
function fmt(ms){return new Date(ms).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'})}
function gap(f,t){let s=Math.max(0,Math.round((t-f)/1000));if(s<60)return s+'s';let m=Math.floor(s/60);return m<60?m+'m '+(s%60)+'s':Math.floor(m/60)+'h '+(m%60)+'m'}
function detailFor(key,J){
  if(key==='gather'&&J.ghLogin){return '@'+esc(J.ghLogin)+(J.ghRepos&&J.ghRepos.length?' · '+esc(J.ghRepos.join(', ')):'')}
  if(key==='paused'&&J.status==='awaiting_approval'){return J.method==='ciba'?'Pushed to your phone':'Link emailed to '+esc(J.email||'you')}
  if(key==='token'&&J.tokenFp){return 'from Token Vault · …'+esc(J.tokenFp)}
  if(key==='acted'&&J.gistUrl){return '<a href="'+esc(J.gistUrl)+'" target="_blank" rel="noopener">view the gist ↗</a>'}
  return ''
}
function flowHTML(J){
  var byKind={};(J.steps||[]).forEach(function(st){byKind[st.kind]=st});
  var status=J.status,keys=STAGES.map(function(s){return s.key});
  var lastPresent=-1;keys.forEach(function(k,i){if(byKind[k])lastPresent=i});
  var pausedIx=keys.indexOf('paused');
  return '<div class="flow">'+STAGES.map(function(s,i){
    var st=byKind[s.key],cls='is-pending',ts='';
    if(st){ ts=fmt(st.at);
      if(s.key==='paused'&&status==='awaiting_approval')cls='is-wait';
      else if(s.key==='paused'&&status==='denied')cls='is-denied';
      else if(status==='error'&&i===lastPresent)cls='is-error';
      else cls='is-done';
    } else if(status==='awaiting_approval'&&i<pausedIx)cls='is-done';
    var glyph=cls==='is-done'?'✓':(cls==='is-denied'||cls==='is-error'?'✕':s.glyph);
    var detail=detailFor(s.key,J);
    return '<div class="fnode '+cls+'"><div class="fnode-mark"><span>'+glyph+'</span></div>'+
      '<div class="fnode-main"><div class="fnode-label">'+esc(s.label)+'</div>'+(detail?'<div class="fnode-detail">'+detail+'</div>':'')+'</div>'+
      (ts?'<div class="fnode-ts">'+ts+'</div>':'<div class="fnode-ts"></div>')+'</div>';
  }).join('')+'</div>';
}
function bannerHTML(J){
  if(J.status==='awaiting_approval'){
    if(J.method==='ciba')return '<div class="banner wait"><b>Approve on your phone.</b> Guardian has the request - the agent is hibernating and wakes the instant you tap approve.</div>';
    return '<div class="banner wait"><b>Check your inbox.</b> Approval link sent to '+esc(J.email||'you')+'. The agent hibernates until you click - approve from any device.</div>';
  }
  if(J.status==='done')return '<div class="banner ok"><b>Done.</b> Resumed and acted with a token fetched <i>at that moment</i> from Token Vault - never one held across the wait.</div>';
  if(J.status==='denied')return '<div class="banner er"><b>Denied.</b> The agent stayed paused and touched nothing.</div>';
  if(J.status==='error')return '<div class="banner er"><b>Something went wrong.</b> See the steps above.</div>';
  return '';
}`
}

// The playground: enrollment, channel choice, run, and the live flow.
function script() {
  return `<script>
${flowJs()}
const $=s=>document.querySelector(s),starter=$('#starter');let J={},timer=null,clockTimer=null,sid=null,lastSig=''

/* segmented control with sliding indicator */
function moveInd(){const a=document.querySelector('.seg-opt.active'),ind=$('#seg-ind');if(a&&ind){ind.style.left=a.offsetLeft+'px';ind.style.width=a.offsetWidth+'px'}}
function selectMethod(m){
  starter.dataset.method=m
  document.querySelectorAll('.seg-opt').forEach(b=>b.classList.toggle('active',b.dataset.method===m))
  $('#panel-email').hidden=m!=='email';$('#panel-ciba').hidden=m!=='ciba';moveInd();setStatus('')
}
document.querySelectorAll('.seg-opt').forEach(b=>b.addEventListener('click',()=>selectMethod(b.dataset.method)))
window.addEventListener('resize',moveInd);requestAnimationFrame(moveInd)
if(new URLSearchParams(location.search).get('enrolled')==='1')selectMethod('ciba')
function setStatus(t,err){const el=$('#status');el.textContent=t||'';el.classList.toggle('err',!!err)}

/* ---- Guardian enrollment: open a popup, poll, update inline, auto-close ---- */
let popup=null,enrollTimer=null
const enrollBtn=$('#ciba-enroll'),removeBtn=$('#ciba-remove')
function setSetup(t){const e=$('#ciba-setup-status');if(e)e.textContent=t||''}
function showEnrolled(device){if(device){const d=$('#ciba-device');if(d)d.textContent=device}$('#ciba-enrolled').hidden=false;$('#ciba-setup').hidden=true;starter.dataset.enrolled='1';setStatus('')}
function showUnenrolled(){$('#ciba-enrolled').hidden=true;$('#ciba-setup').hidden=false;starter.dataset.enrolled='0'}
if(enrollBtn)enrollBtn.onclick=async()=>{
  popup=window.open('','guardian','width=460,height=720')  // open in the gesture so it isn't blocked
  enrollBtn.disabled=true;setSetup('opening…')
  try{
    const r=await fetch('/agent/enroll',{method:'POST'});const j=await r.json()
    if(!j.ok||!j.ticketUrl)throw new Error(j.reason||'failed')
    if(popup)popup.location=j.ticketUrl
    setSetup('scan the QR in Guardian, waiting…')
    pollEnroll()
  }catch(e){if(popup)popup.close();enrollBtn.disabled=false;setSetup('could not start, try again')}
}
function pollEnroll(){
  let n=0;clearInterval(enrollTimer)
  enrollTimer=setInterval(async()=>{
    n++
    try{
      const r=await fetch('/agent/enrollment-status');const j=await r.json()
      if(j.ok&&j.enrolled){clearInterval(enrollTimer);if(popup&&!popup.closed)popup.close();enrollBtn.disabled=false;setSetup('');showEnrolled(j.device);return}
    }catch(e){}
    if(popup&&popup.closed){clearInterval(enrollTimer);enrollBtn.disabled=false;setSetup('')}
    else if(n>120){clearInterval(enrollTimer);enrollBtn.disabled=false;setSetup('timed out, try again')}
  },2500)
}
if(removeBtn)removeBtn.onclick=async()=>{
  removeBtn.disabled=true;removeBtn.textContent='removing…'
  try{const r=await fetch('/agent/unenroll',{method:'POST'});const j=await r.json();if(j.ok)showUnenrolled()}catch(e){}
  removeBtn.disabled=false;removeBtn.textContent='Remove'
}

/* ---- run a session ---- */
$('#run').onclick=start
$('#again').onclick=()=>location.reload()
async function start(){
  const topic=$('#topic').value.trim()
  if(!topic){setStatus('Give the agent a task first.',1);return}
  const method=starter.dataset.method||'email';let email=''
  if(method==='email'){email=$('#email').value.trim();if(!/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(email)){setStatus('Enter a valid email.',1);return}}
  else if(starter.dataset.enrolled!=='1'){setStatus('Set up Guardian first, or use Email link.',1);return}
  $('#run').disabled=true;$('#topic').disabled=true;document.querySelectorAll('.seg-opt').forEach(b=>b.disabled=true);setStatus('starting…')
  const r=await fetch('/agent/session/start',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({topic,email,method})})
  const res=await r.json()
  if(!res.ok){$('#run').disabled=false;$('#topic').disabled=false;document.querySelectorAll('.seg-opt').forEach(b=>b.disabled=false);setStatus(reason(res.reason),1);return}
  sid=res.id;setStatus('')
  poll();timer=setInterval(poll,1500);clockTimer=setInterval(tickClock,1000)
}
function reason(c){return({invalid_email:'Enter a valid email.',invalid_topic:'Give the agent a task first.',rate_limited:'Too many sessions - wait a minute.',not_connected:'Re-vault GitHub and try again.'})[c]||'Could not start - try again.'}
function tickClock(){if(!J||J.status!=='awaiting_approval'||!J.pausedAt)return;const el=$('#clock');if(el)el.textContent='⏸ hibernating · '+gap(J.pausedAt,Date.now())}
async function poll(){
  if(!sid)return
  const r=await fetch('/agent/session/'+sid);if(!r.ok)return
  J=await r.json();render()
  if(['done','denied','error'].includes(J.status)){clearInterval(timer);clearInterval(clockTimer);finish()}
}
function render(){
  const clock=$('#clock')
  if(J.status==='awaiting_approval'){clock.hidden=false;clock.textContent='⏸ hibernating · '+gap(J.pausedAt,Date.now())}else{clock.hidden=true}
  const sig=J.status+':'+((J.steps||[]).length)+':'+(J.gistUrl||'')
  if(sig===lastSig)return
  lastSig=sig
  $('#flow-banner').innerHTML=bannerHTML(J)
  $('#flowbox').innerHTML=flowHTML(J)
  let extra=''
  if(J.audit&&J.audit.length){extra='<button class="jsontoggle" onclick="this.nextElementSibling.hidden=!this.nextElementSibling.hidden">audit · '+J.audit.length+' events</button><pre hidden>'+esc(J.audit.map(e=>fmt(e.at)+'  '+e.type).join('\\n'))+'</pre>'}
  $('#flow-extra').innerHTML=extra
}
function finish(){
  if(J.status==='done'){const f=$('.play-flow');f.classList.add('win');setTimeout(()=>f.classList.remove('win'),1200)}
  $('#run').hidden=true;$('#again').hidden=false
}
</script>`
}

// Read-only session viewer: ?id=... renders the same flow on the email landing
// page (another device, no cookie).
function viewerScript() {
  return `<script>
${flowJs()}
const params=new URLSearchParams(location.search),sid=params.get('id')
if(sid&&location.pathname.includes('session-view')){
  const wrap=document.querySelector('.wrap')
  const card=document.createElement('div');card.className='card play-flow'
  card.innerHTML='<div class="flow-head"><span class="flow-title">Agent run</span><span class="tl-clock" id="clock" hidden></span></div><div id="flow-banner"></div><div id="flowbox"></div><div id="flow-extra"></div>'
  wrap.insertBefore(card,wrap.firstChild)
  let J={},lastSig='',timer=setInterval(poll,1500),clockTimer=setInterval(tickClock,1000)
  function tickClock(){if(!J||J.status!=='awaiting_approval'||!J.pausedAt)return;const el=document.querySelector('#clock');if(el)el.textContent='⏸ hibernating · '+gap(J.pausedAt,Date.now())}
  async function poll(){const r=await fetch('/agent/session/'+sid);if(!r.ok)return;J=await r.json();render();if(['done','denied','error'].includes(J.status)){clearInterval(timer);clearInterval(clockTimer)}}
  function render(){const clock=document.querySelector('#clock');if(J.status==='awaiting_approval'){clock.hidden=false;clock.textContent='⏸ hibernating · '+gap(J.pausedAt,Date.now())}else{clock.hidden=true}var sig=J.status+':'+((J.steps||[]).length)+':'+(J.gistUrl||'');if(sig===lastSig)return;lastSig=sig;document.querySelector('#flow-banner').innerHTML=bannerHTML(J);document.querySelector('#flowbox').innerHTML=flowHTML(J)}
  poll()
}
</script>`
}
