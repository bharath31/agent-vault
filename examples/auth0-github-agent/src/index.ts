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
    // Approve / deny arrive from the EMAIL link — no cookie required (the magic
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
      // Plain OIDC login via GitHub. With MRRT enabled, the resulting refresh
      // token can be exchanged for a My Account API token during /connect.
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
      const sess: Session = {
        sub: claims.sub ?? 'user',
        name: claims.name ?? claims.nickname,
        email: claims.email,
        refreshToken: tok.refresh_token,
        vaulted: false,
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
    // wakes and nominee fetches the token AT ACTION TIME — never a stale one.
    if (request.method === 'POST' && path.endsWith('/session/start')) {
      if (!session) return json({ ok: false, reason: 'not_logged_in' }, 401)
      if (!session.vaulted) return json({ ok: false, reason: 'not_connected' }, 403)
      const b = (await request.json().catch(() => ({}))) as { topic?: string; email?: string }
      const topic = cleanTopic(b.topic)
      if (!topic) return json({ ok: false, reason: 'invalid_topic' }, 400)
      const email = (b.email || session.email || '').trim()
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
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
          refreshToken: session.refreshToken,
        }),
      })
      const out = (await r.json().catch(() => ({}))) as object
      return json({ ok: r.ok, id, ...out }, r.status)
    }

    return new Response(page(session), { headers: { 'content-type': 'text/html; charset=utf-8' } })
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
   *  read from durable storage at call time — so it survives hibernation. */
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
      refreshToken: string
    }
    const now = Date.now()
    const audit: SessionState['audit'] = []
    const s: SessionState = {
      ...init,
      approvalKey: crypto.randomUUID(),
      status: 'awaiting_approval',
      steps: [{ kind: 'started', at: now, text: `agent session started — "${init.topic}"` }],
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
      text: 'drafted a gist summarizing this session — needs your approval to publish',
    })
    s.pausedAt = Date.now()
    s.steps.push({
      kind: 'paused',
      at: s.pausedAt,
      text: `paused — approval link emailed to ${s.email}. Agent is hibernating; it will resume when you approve.`,
    })

    await this.save(s)

    // Send the out-of-band approval email. The agent now does NOTHING until the
    // link is clicked — no compute, no polling, just durable state.
    await this.sendApprovalEmail(s)

    return json({ status: s.status })
  }

  /** Phase 2: woken by the email link. nominee fetches a token AT THIS MOMENT
   *  (not at session start) and the agent publishes — surviving the pause. */
  private async resolve(decision: 'approved' | 'denied', k: string): Promise<Response> {
    const s = await this.load()
    if (!s) return json({ ok: false, reason: 'unknown_session' }, 404)
    if (s.status === 'done' || s.status === 'denied')
      return json({ ok: s.status === 'done', already: true, gistUrl: s.gistUrl }, 200)
    if (k !== s.approvalKey) return json({ ok: false, reason: 'bad_key' }, 403)

    s.resumedAt = Date.now()
    s.steps.push({
      kind: 'resumed',
      at: s.resumedAt,
      text: `you ${decision} from your inbox — agent woke after ${humanGap(s.pausedAt, s.resumedAt)} of hibernation`,
    })

    if (decision === 'denied') {
      s.status = 'denied'
      await this.save(s)
      return json({ ok: false, decision })
    }

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
        description: `Agent session: ${s.topic} — published via nominee + Auth0 Token Vault`,
        public: true,
        files: { 'agent-session.md': { content: gistBody(s) } },
      })
      if (!gist.ok) {
        s.status = 'error'
        s.steps.push({ kind: 'error', at: Date.now(), text: `publish failed (${gist.status})` })
        await this.save(s)
        return json({ ok: false, reason: 'publish_failed', status: gist.status }, 502)
      }
      s.gistUrl = gist.url
      s.status = 'done'
      s.steps.push({ kind: 'acted', at: Date.now(), text: 'published a gist to your GitHub' })
      await this.save(s)
      return json({ ok: true, decision, gistUrl: s.gistUrl })
    } catch (err) {
      s.status = 'error'
      s.steps.push({ kind: 'error', at: Date.now(), text: short(err) })
      await this.save(s)
      return json({ ok: false, reason: 'token_vault_failed', error: short(err) }, 502)
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
  return `# Agent session: ${s.topic}\n\nThis gist was published by an autonomous agent acting for ${who}, after ${who} approved it from their inbox.\n\n${repos}The agent paused and **hibernated** while waiting for approval. When approval arrived, **nominee** fetched a fresh, short-lived GitHub token from **Auth0 Token Vault** at the moment of the action — it never held a captured token across the pause. The agent never saw a password.\n\n— via https://nominee.dev\n`
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
  <p style="font-family:ui-monospace,monospace;font-size:12px;letter-spacing:.15em;text-transform:uppercase;color:#b8860b">nominee · approval required</p>
  <h2 style="font-size:20px;margin:8px 0 4px">Your agent paused for you, ${who}.</h2>
  <p style="color:#444;line-height:1.5">An autonomous agent wants to <b>publish a gist on your GitHub</b>:</p>
  <p style="background:#f4f4f5;border-radius:8px;padding:12px 14px;color:#222;font-size:15px">${escapeHtml(s.topic)}</p>
  <p style="color:#444;line-height:1.5;font-size:14px">It's <b>hibernating</b> until you decide. Approve and it resumes — nominee fetches a fresh token from Auth0 Token Vault <i>at that moment</i>, never a stale one.</p>
  <div style="margin:24px 0">
    <a href="${approve}" style="background:#d9a441;color:#1a1205;font-weight:600;text-decoration:none;padding:13px 22px;border-radius:9px;display:inline-block;margin-right:10px">✓ Approve &amp; publish</a>
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
    ? '✓ Approved — your agent resumed'
    : decision === 'denied'
      ? 'Denied — nothing was published'
      : 'Could not complete'
  const body = ok
    ? `nominee fetched a fresh GitHub token from Token Vault at action time and the agent published your gist.${out.gistUrl ? ` <a href="${escapeHtml(out.gistUrl)}" style="color:#d9a441">View it ↗</a>` : ''}`
    : decision === 'denied'
      ? 'The agent stayed paused and took no action on your account.'
      : 'This approval link may have already been used, or the session expired.'
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>nominee · ${escapeHtml(head)}</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;background:#0a1020;color:#e8ecf6;min-height:100vh;display:grid;place-items:center;margin:0;padding:24px}
.card{max-width:440px;text-align:center;background:linear-gradient(180deg,#0f1830,#0c1428);border:1px solid rgba(214,224,245,.12);border-radius:16px;padding:40px 28px}
h1{font-size:24px;margin:0 0 12px;letter-spacing:-.02em}p{color:#c4ccde;line-height:1.6}a{color:#d9a441}
.back{font-family:ui-monospace,monospace;font-size:13px;color:#7e8ba6;margin-top:24px;display:inline-block}</style></head>
<body><div class="card"><h1>${escapeHtml(head)}</h1><p>${body}</p>
<a class="back" href="${ORIGIN}/agent/session-view?id=${escapeHtml(id)}">watch the full session timeline →</a></div></body></html>`
}

function page(session: Session | null) {
  const loggedOut = `
    <p class="lede">Start a real agent session. It reads your GitHub, drafts a gist, then <em>pauses and emails you</em> for approval — and only acts after you click the link. nominee fetches a <em>fresh</em> token from <strong>Auth0 Token Vault</strong> at the moment of the action.</p>
    <a class="primary" href="/agent/login">Connect GitHub via Auth0 →</a>
    <p class="foot" style="margin-top:24px">You log in once (real OAuth consent). The agent never sees your password or stores your token.</p>`
  const needVault = `
    <p class="lede">Signed in as <strong>${escapeHtml(session?.name || session?.sub || 'you')}</strong>. Now vault your GitHub token with Auth0 Token Vault so nominee can pull a fresh one per action. <a href="/agent/logout">log out</a></p>
    <div class="card">
      <label>Step 2 of 2 · Vault GitHub in Token Vault</label>
      <p class="sub" style="margin:6px 0 16px">Authorizes nominee to fetch fresh GitHub tokens on your behalf. You can revoke this any time.</p>
      <a class="primary" href="/agent/connect">Vault GitHub token →</a>
    </div>`
  const ready = `
    <p class="lede">Connected &amp; vaulted as <strong>${escapeHtml(session?.name || session?.sub || 'you')}</strong>. Start a session — the agent works, then <em>pauses and emails you</em> for approval. Approve from your phone; the agent wakes and acts with a token nominee pulls <em>then</em>, not now. <a href="/agent/disconnect">disconnect &amp; re-vault</a> · <a href="/agent/logout">log out</a></p>
    <div class="card" id="starter">
      <label for="topic">What should the agent work on?</label>
      <input id="topic" type="text" value="Summary of my recent GitHub activity" maxlength="140" />
      <label for="email" style="margin-top:14px">Send the approval to</label>
      <input id="email" type="email" value="${escapeHtml(session?.email || '')}" placeholder="you@example.com" />
      <div class="row"><button id="run" class="primary">Start agent session ▸</button><span id="status" class="sub"></span></div>
    </div>
    <div id="timeline" class="card" hidden></div>`
  return html(
    !session ? loggedOut : session.vaulted ? ready : needVault,
    !!session && !!session.vaulted,
  )
}

// Tiny shim: if Auth0 returned connect_code in the URL fragment (not sent to the
// server), extract it client-side and re-request this route with it as a query param.
function connectCodeShim() {
  return `<!doctype html><html><head><meta charset="utf-8"><title>completing…</title></head><body>
<script>
const m=location.hash.match(/connect_code=([^&]+)/)||location.search.match(/connect_code=([^&]+)/);
if(m){location.replace('/agent/connect/callback?connect_code='+encodeURIComponent(m[1]));}
else{document.body.textContent='Missing connect_code — please reconnect.';}
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
:root{--ink:#0a1020;--raised:#0f1830;--hair:rgba(214,224,245,.12);--paper:#e8ecf6;--soft:#c4ccde;--muted:#7e8ba6;--seal:#d9a441;--ok:#7fd1a6;--err:#ff6b6b;--sans:'Schibsted Grotesk',system-ui,sans-serif;--mono:'Geist Mono',ui-monospace,monospace}
*{margin:0;box-sizing:border-box}body{font-family:var(--sans);background:radial-gradient(900px 500px at 80% -10%,rgba(217,164,65,.08),transparent 60%),var(--ink);color:var(--paper);min-height:100vh;line-height:1.55}
.wrap{max-width:680px;margin:0 auto;padding:clamp(28px,6vw,72px) 22px 80px}
.eyebrow{font-family:var(--mono);font-size:12px;letter-spacing:.2em;text-transform:uppercase;color:var(--seal);margin-bottom:14px}
h1{font-size:clamp(28px,5vw,40px);letter-spacing:-.03em;margin-bottom:12px}
.lede{color:var(--soft);margin-bottom:24px}.lede a{color:var(--muted);border-bottom:1px solid var(--hair)}em{color:var(--seal);font-style:normal}
.steps{display:flex;gap:8px;font-family:var(--mono);font-size:11px;color:var(--muted);margin-bottom:22px;flex-wrap:wrap}.steps b{color:var(--seal);font-weight:500}
.card{background:linear-gradient(180deg,var(--raised),#0c1428);border:1px solid var(--hair);border-radius:14px;padding:22px;margin-bottom:16px}
label{font-family:var(--mono);font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);display:block;margin-bottom:8px}
input{width:100%;font-family:var(--mono);font-size:15px;color:var(--paper);background:rgba(255,255,255,.03);border:1px solid var(--hair);border-radius:9px;padding:13px 14px}input:focus{outline:none;border-color:rgba(217,164,65,.5)}
.row{display:flex;gap:10px;flex-wrap:wrap;margin-top:16px;align-items:center}
a.primary,button{font-family:var(--mono);font-size:14px;cursor:pointer;border-radius:9px;padding:13px 20px;border:1px solid var(--hair);background:rgba(255,255,255,.04);color:var(--paper);transition:.15s;text-decoration:none;display:inline-block}
.primary{background:var(--seal);color:#1a1205;border-color:var(--seal);font-weight:600}button:disabled{opacity:.5}
.sub{font-size:13px;color:var(--muted)}.foot{font-family:var(--mono);font-size:12px;color:var(--muted)}
.tl{list-style:none;padding:0;margin:0;font-family:var(--mono);font-size:13px}
.tl li{display:flex;gap:12px;padding:9px 0;border-bottom:1px solid var(--hair);align-items:flex-start}
.tl li:last-child{border-bottom:none}
.tl .ic{flex:none;width:18px;text-align:center}.tl .ic.ok{color:var(--ok)}.tl .ic.ac{color:var(--seal)}.tl .ic.er{color:var(--err)}.tl .ic.wait{color:var(--seal)}
.tl .tx{color:var(--soft)}.tl .ts{color:var(--muted);margin-left:auto;flex:none;font-size:11px;padding-left:10px}
.pulse{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--seal);animation:p 1.2s infinite}
@keyframes p{0%,100%{opacity:.3}50%{opacity:1}}
.clock{font-family:var(--mono);font-size:13px;color:var(--seal);margin-top:14px}
.jsontoggle{font-family:var(--mono);font-size:12px;color:var(--muted);background:none;border:none;border-bottom:1px solid var(--hair);padding:0 0 2px;margin-top:14px;cursor:pointer}
pre{font-family:var(--mono);font-size:12px;color:var(--soft);background:#070c18;border:1px solid var(--hair);border-radius:10px;padding:14px;overflow:auto;margin-top:10px}
.banner{font-family:var(--mono);font-size:12.5px;border-radius:10px;padding:12px 14px;margin-bottom:14px}
.banner.wait{background:rgba(217,164,65,.1);border:1px solid rgba(217,164,65,.3);color:var(--seal)}
.banner.ok{background:rgba(127,209,166,.08);border:1px solid rgba(127,209,166,.3);color:var(--ok)}
.banner.er{background:rgba(255,107,107,.08);border:1px solid rgba(255,107,107,.3);color:var(--err)}
</style></head><body><div class="wrap">
<p class="eyebrow">Live testbed · durable agent + out-of-band approval</p>
<h1>An agent that pauses, emails you, and survives the wait.</h1>
<div class="steps">① <b>connect GitHub</b> → ② agent reads your account → ③ <b>pauses + emails you</b> → ④ approve from your phone → ⑤ <b>fresh token from Token Vault</b> at action time → ⑥ real action + audit</div>
${inner}
<p class="foot" style="margin-top:28px;text-align:center"><a href="${ORIGIN}" style="color:var(--soft)">← nominee.dev</a> · <a href="https://github.com/bharath31/nominee" style="color:var(--soft)">source ↗</a></p>
</div>
${loggedIn ? script() : viewerScript()}
</body></html>`
}

// The console UI: start a session, then poll + render the live timeline.
function script() {
  return `<script>
const $=s=>document.querySelector(s);let J={},timer=null,clockTimer=null,sid=null
function esc(s){return String(s).replace(/[&<>]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[m]))}
function fmt(ms){const d=new Date(ms);return d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'})}
function gap(from,to){let s=Math.max(0,Math.round((to-from)/1000));if(s<60)return s+'s';let m=Math.floor(s/60);return m<60?m+'m '+(s%60)+'s':Math.floor(m/60)+'h '+(m%60)+'m'}
const ICON={started:['●','ac'],gather:['✓','ok'],draft:['✎','ac'],paused:['⏸','wait'],resumed:['▸','ok'],token:['↻','ac'],acted:['✓','ok'],error:['✗','er']}

$('#run').onclick=start
async function start(){
  const topic=$('#topic').value.trim(),email=$('#email').value.trim()
  if(!/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(email)){$('#status').textContent='enter a valid email';return}
  $('#run').disabled=true;$('#status').innerHTML='<span class="pulse"></span> starting…'
  const r=await fetch('/agent/session/start',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({topic,email})})
  const res=await r.json()
  if(!res.ok){$('#run').disabled=false;$('#status').textContent=res.reason||'failed';return}
  sid=res.id;$('#status').textContent=''
  $('#timeline').hidden=false
  poll();timer=setInterval(poll,1500)
  clockTimer=setInterval(renderClock,1000)
}
async function poll(){
  if(!sid)return
  const r=await fetch('/agent/session/'+sid);if(!r.ok)return
  J=await r.json();render()
  if(['done','denied','error'].includes(J.status)){clearInterval(timer);clearInterval(clockTimer)}
}
function renderClock(){
  if(!J||J.status!=='awaiting_approval'||!J.pausedAt)return
  const el=$('#clock');if(el)el.textContent='⏸ hibernating — '+gap(J.pausedAt,Date.now())+' waiting for your approval'
}
function render(){
  let banner='',clock=''
  if(J.status==='awaiting_approval'){
    banner='<div class="banner wait"><b>Check your inbox.</b> The agent emailed an approval link to '+esc(J.email)+' and is now hibernating — no compute running. Approve from any device.</div>'
    clock='<div class="clock" id="clock">⏸ hibernating — '+gap(J.pausedAt,Date.now())+' waiting for your approval</div>'
  } else if(J.status==='done'){
    banner='<div class="banner ok"><b>Done.</b> The agent resumed after the pause and acted with a token nominee fetched <i>at that moment</i> from Token Vault.</div>'
  } else if(J.status==='denied'){
    banner='<div class="banner er">Denied — the agent stayed paused and took no action.</div>'
  } else if(J.status==='error'){
    banner='<div class="banner er">Something went wrong — see the timeline.</div>'
  }
  let items=(J.steps||[]).map(st=>{
    const [ic,cls]=ICON[st.kind]||['•','']
    return '<li><span class="ic '+cls+'">'+ic+'</span><span class="tx">'+esc(st.text)+'</span><span class="ts">'+fmt(st.at)+'</span></li>'
  }).join('')
  let link=J.gistUrl?'<div style="margin-top:14px"><a href="'+esc(J.gistUrl)+'" target="_blank" style="color:var(--seal);font-family:var(--mono);font-size:13px">'+esc(J.gistUrl)+' ↗</a></div>':''
  let audit=J.audit&&J.audit.length?'<button class="jsontoggle" onclick="this.nextElementSibling.hidden=!this.nextElementSibling.hidden">audit ('+J.audit.length+' events)</button><pre hidden>'+esc(J.audit.map(e=>fmt(e.at)+'  '+e.type).join('\\n'))+'</pre>':''
  $('#timeline').innerHTML='<label>Agent session</label>'+banner+'<ul class="tl">'+items+'</ul>'+clock+link+audit
}
</script>`
}

// Standalone session viewer (e.g. opened from the email landing page on another
// device, with no cookie): ?id=... renders the same live timeline, read-only.
function viewerScript() {
  return `<script>
const params=new URLSearchParams(location.search),sid=params.get('id')
if(sid&&location.pathname.includes('session-view')){
  const root=document.querySelector('.wrap')
  const card=document.createElement('div');card.className='card';card.id='timeline';root.querySelector('.steps').after(card)
  let J={},timer=setInterval(poll,1500),clockTimer=setInterval(renderClock,1000)
  function esc(s){return String(s).replace(/[&<>]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[m]))}
  function fmt(ms){return new Date(ms).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'})}
  function gap(f,t){let s=Math.max(0,Math.round((t-f)/1000));if(s<60)return s+'s';let m=Math.floor(s/60);return m<60?m+'m '+(s%60)+'s':Math.floor(m/60)+'h '+(m%60)+'m'}
  const ICON={started:['●','ac'],gather:['✓','ok'],draft:['✎','ac'],paused:['⏸','wait'],resumed:['▸','ok'],token:['↻','ac'],acted:['✓','ok'],error:['✗','er']}
  async function poll(){const r=await fetch('/agent/session/'+sid);if(!r.ok)return;J=await r.json();render();if(['done','denied','error'].includes(J.status)){clearInterval(timer);clearInterval(clockTimer)}}
  function renderClock(){if(!J||J.status!=='awaiting_approval'||!J.pausedAt)return;const el=document.querySelector('#clock');if(el)el.textContent='⏸ hibernating — '+gap(J.pausedAt,Date.now())+' waiting for approval'}
  function render(){let items=(J.steps||[]).map(st=>{const[ic,cls]=ICON[st.kind]||['•',''];return '<li><span class="ic '+cls+'">'+ic+'</span><span class="tx">'+esc(st.text)+'</span><span class="ts">'+fmt(st.at)+'</span></li>'}).join('');let clock=J.status==='awaiting_approval'?'<div class="clock" id="clock">⏸ hibernating</div>':'';let link=J.gistUrl?'<div style="margin-top:14px"><a href="'+esc(J.gistUrl)+'" target="_blank" style="color:var(--seal)">'+esc(J.gistUrl)+' ↗</a></div>':'';document.querySelector('#timeline').innerHTML='<label>Agent session timeline</label><ul class="tl">'+items+'</ul>'+clock+link}
  poll()
}
</script>`
}
