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
const cleanNote = (s: unknown): string | null => {
  const t = String(s ?? '')
    .trim()
    .slice(0, 280)
  return t.length ? t : null
}
const gistContent = (note: string, who: string) =>
  `# ${note}\n\n_Published to GitHub by an autonomous agent — with ${who}'s approval._\n\nAn AI agent created this gist on my behalf. It never saw my password or a stored token. At the moment it published, **nominee** fetched a fresh, short-lived GitHub token from **Auth0 Token Vault** — and only after I clicked **Approve**.\n\n— via https://nominee.dev\n`

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

    // ---- 1. login: authenticate the user via GitHub, requesting a refresh token
    //         scoped to the My Account API (so we can drive Connected Accounts) ----
    if (path.endsWith('/login')) {
      const u = new URL(`https://${env.AUTH0_DOMAIN}/authorize`)
      u.searchParams.set('response_type', 'code')
      u.searchParams.set('client_id', env.AUTH0_CLIENT_ID)
      u.searchParams.set('redirect_uri', REDIRECT)
      // Plain OIDC login via GitHub. With MRRT enabled, the resulting refresh
      // token can be exchanged for a My Account API token during /connect —
      // no need to request the /me/ audience up front (which the client grant
      // for the My Account API may not yet permit at /authorize time).
      u.searchParams.set('scope', 'openid profile offline_access')
      u.searchParams.set('connection', 'github') // primary auth via GitHub
      return Response.redirect(u.toString(), 302)
    }

    // ---- 2. callback: exchange code → store the Auth0 refresh token in a sealed cookie ----
    // NOTE: must not match /connect/callback — that's handled below.
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
    //          from scratch. Required after changing the GitHub App's granted permissions —
    //          otherwise Connected Accounts reuses the old, permission-less vault entry. ----
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
    // The connect_code may arrive as a query param (server redirect) or a URL fragment
    // (browser-only). If it's missing from the query, serve a shim that pulls it from the
    // hash and re-requests this route with it as a query param.
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

    // ---- 5. the real action: agent stars a repo on YOUR GitHub, after YOUR approval ----
    if (request.method === 'POST' && path.endsWith('/execute')) {
      if (!session) return json({ ok: false, reason: 'not_logged_in' }, 401)
      if (!session.vaulted) return json({ ok: false, reason: 'not_connected' }, 403)
      const b = (await request.json().catch(() => ({}))) as { note?: string; decision?: string }
      const note = cleanNote(b.note)
      if (!note) return json({ ok: false, reason: 'invalid_note' }, 400)
      const decision = b.decision === 'approved' ? 'approved' : 'denied'

      const audit: unknown[] = []
      const nominee = new Nominee({
        // nominee fetches a fresh GitHub token for THIS user from Auth0 Token Vault
        strategy: Auth0({
          domain: env.AUTH0_DOMAIN,
          clientId: env.AUTH0_CLIENT_ID,
          clientSecret: env.AUTH0_CLIENT_SECRET,
          subjectToken: () => session.refreshToken,
          subjectTokenType: 'refresh_token',
        }),
        onApprovalRequest: (req) => req.resolve(decision),
        onAudit: (e) => audit.push(e),
        agent: 'github-agent',
      })

      try {
        await nominee.approve({ user: session.sub, action: 'github.gist', detail: { note } })
      } catch {
        return json({ ok: true, decision, created: false, audit })
      }

      const ip = request.headers.get('cf-connecting-ip') ?? 'anon'
      if (!(await env.STAR_RL.limit({ key: ip })).success)
        return json({ ok: false, reason: 'rate_limited' }, 429)

      let token: string
      try {
        token = await nominee.token({ user: session.sub, connection: 'github' })
      } catch (err) {
        return json({ ok: false, reason: 'token_vault_failed', error: String(err), audit }, 502)
      }

      const gh = await fetch('https://api.github.com/gists', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'user-agent': 'nominee-demo',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          description: 'Published by an AI agent on my behalf — nominee + Auth0 Token Vault demo',
          public: true,
          files: {
            'from-my-agent.md': { content: gistContent(note, session.name || session.sub) },
          },
        }),
      })
      const result = (await gh.json().catch(() => ({}))) as { html_url?: string; message?: string }
      const ghDiag = gh.ok
        ? undefined
        : {
            accepted: gh.headers.get('x-accepted-github-permissions') ?? undefined,
            oauthScopes: gh.headers.get('x-oauth-scopes') ?? undefined,
            message: result.message,
          }
      return json({
        ok: gh.ok,
        decision,
        created: gh.ok,
        status: gh.status,
        url: result.html_url,
        ghDiag,
        audit,
      })
    }

    return new Response(page(session), { headers: { 'content-type': 'text/html; charset=utf-8' } })
  },
}

async function getSession(req: Request, env: Env): Promise<Session | null> {
  const c = getCookie(req, COOKIE)
  return c ? unseal<Session>(env.SESSION_SECRET, c) : null
}
function decodeJwt(jwt: string): { sub?: string; name?: string; nickname?: string } {
  try {
    return JSON.parse(
      new TextDecoder().decode(ub64(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))),
    )
  } catch {
    return {}
  }
}

function page(session: Session | null) {
  const loggedOut = `
    <p class="lede">Connect your GitHub through Auth0. nominee then fetches a <em>fresh</em> token for <strong>your</strong> account from <strong>Token Vault</strong> at the moment of the action — and only after <strong>you</strong> approve it.</p>
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
    <p class="lede">Connected &amp; vaulted as <strong>${escapeHtml(session?.name || session?.sub || 'you')}</strong>. Ask the agent to publish a gist <em>on your account</em>. Nothing happens until you approve — then nominee pulls your token from Token Vault and acts. <a href="/agent/disconnect">disconnect &amp; re-vault</a> · <a href="/agent/logout">log out</a></p>
    <div class="card">
      <label for="note">What should the agent publish?</label>
      <input id="note" type="text" value="Notes from my agent session" maxlength="280" />
      <div class="row"><button id="run" class="primary">Ask agent to publish it ▸</button><span id="status" class="sub"></span></div>
    </div>
    <div id="proposal" class="card" hidden></div>
    <div id="result" class="card" hidden></div>`
  return html(
    !session ? loggedOut : session.vaulted ? ready : needVault,
    !!session && !!session.vaulted,
  )
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[m] as string)

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
<title>nominee · live testbed</title>
<link rel="icon" href="${ORIGIN}/assets/icon.svg" type="image/svg+xml" />
<link rel="preconnect" href="https://fonts.googleapis.com" /><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Schibsted+Grotesk:wght@400;500;600&family=Geist+Mono:wght@400;500&display=swap" rel="stylesheet" />
<style>
:root{--ink:#0a1020;--raised:#0f1830;--hair:rgba(214,224,245,.12);--paper:#e8ecf6;--soft:#c4ccde;--muted:#7e8ba6;--seal:#d9a441;--sans:'Schibsted Grotesk',system-ui,sans-serif;--mono:'Geist Mono',ui-monospace,monospace}
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
.primary,.approve{background:var(--seal);color:#1a1205;border-color:var(--seal);font-weight:600}.deny{color:var(--soft)}button:disabled{opacity:.5}
.log{font-family:var(--mono);font-size:13.5px;line-height:1.95}.log .m{color:var(--muted)}.log .ok{color:#7fd1a6}.log .err{color:#ff6b6b}.log .ac{color:var(--seal)}
.sub{font-size:13px;color:var(--muted)}.foot{font-family:var(--mono);font-size:12px;color:var(--muted)}
.jsontoggle{font-family:var(--mono);font-size:12px;color:var(--muted);background:none;border:none;border-bottom:1px solid var(--hair);padding:0 0 2px;margin-top:14px}
pre{font-family:var(--mono);font-size:12px;color:var(--soft);background:#070c18;border:1px solid var(--hair);border-radius:10px;padding:14px;overflow:auto;margin-top:10px}
</style></head><body><div class="wrap">
<p class="eyebrow">Live testbed · real delegated access</p>
<h1>An agent acting on your GitHub — with your consent.</h1>
<div class="steps">① <b>connect GitHub</b> (OAuth consent) → ② vaulted by Auth0 → ③ agent proposes → ④ <b>your approval</b> → ⑤ <b>fresh token from Token Vault</b> → ⑥ real action + audit</div>
${inner}
<p class="foot" style="margin-top:28px;text-align:center"><a href="${ORIGIN}" style="color:var(--soft)">← nominee.dev</a> · <a href="https://github.com/bharath31/nominee" style="color:var(--soft)">source ↗</a></p>
</div>
${loggedIn ? script() : ''}
</body></html>`
}

function script() {
  return `<script>
const $=s=>document.querySelector(s);let J={};
function esc(s){return String(s).replace(/[&<>]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[m]))}
function jb(){return '<button class="jsontoggle" onclick="this.nextElementSibling.hidden=!this.nextElementSibling.hidden">show JSON</button><pre hidden>'+esc(JSON.stringify(J,null,2))+'</pre>'}
function line(c,t){return '<div><span class="'+c+'">'+esc(t)+'</span></div>'}
$('#run').onclick=()=>{
  const note=$('#note').value.trim()
  $('#proposal').hidden=false
  $('#proposal').innerHTML='<label>Agent proposes</label><div class="log"><span class="ac">github.gist</span> <span class="m">publish &ldquo;</span>'+esc(note)+'<span class="m">&rdquo; to your account</span></div><p class="sub">Sensitive: nominee is holding it for your approval.</p><div class="row"><button class="approve" id="ap">✓ Approve</button><button class="deny" id="dn">Deny</button></div>'
  $('#ap').onclick=()=>go(note,'approved');$('#dn').onclick=()=>go(note,'denied')
}
async function go(note,decision){
  $('#ap').disabled=true;$('#dn').disabled=true
  if(decision==='approved')$('#ap').innerHTML='publishing…'
  const r=await fetch('/agent/execute',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({note,decision})});const res=await r.json();J=res
  $('#result').hidden=false
  let log=line('m','$ approval '+decision)
  if(decision==='approved'&&res.created){log+=line('ac','⚸ you approved');log+=line('ok','✓ nominee pulled a fresh token from Auth0 Token Vault');log+=line('ok','✓ published a gist to your GitHub');if(res.url)log+='<div><a href="'+esc(res.url)+'" target="_blank" style="color:var(--seal)">'+esc(res.url)+' ↗</a></div>'}
  else if(decision==='denied'){log+=line('err','✗ denied — nothing happened on your account')}
  else{log+=line('err','✗ '+esc(res.reason||'failed')+(res.status?' ('+res.status+')':''))}
  log+='\\n'+line('m','audit  '+((res.audit||[]).map(e=>e.type).join(' → ')||'—'))
  $('#result').innerHTML='<label>Result</label><div class="log">'+log+'</div>'+jb()
  $('#ap').innerHTML='✓ Approve'
}
</script>`
}
