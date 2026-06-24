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
const COOKIE = 'nominee_sess'

const json = (d: unknown, s = 200) =>
  new Response(JSON.stringify(d, null, 2), {
    status: s,
    headers: { 'content-type': 'application/json' },
  })
const cleanRepo = (s: unknown): string | null => {
  const r = String(s ?? '')
    .trim()
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/\/+$/, '')
  return /^[\w.-]+\/[\w.-]+$/.test(r) ? r : null
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
  refreshToken: string
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname.replace(/\/+$/, '') || '/agent'

    // ---- 1. start login: send the user to Auth0, logging in via GitHub ----
    if (path.endsWith('/login')) {
      const u = new URL(`https://${env.AUTH0_DOMAIN}/authorize`)
      u.searchParams.set('response_type', 'code')
      u.searchParams.set('client_id', env.AUTH0_CLIENT_ID)
      u.searchParams.set('redirect_uri', REDIRECT)
      u.searchParams.set('scope', 'openid profile offline_access')
      u.searchParams.set('connection', 'github') // log in via the GitHub connection → Token Vault stores it
      return Response.redirect(u.toString(), 302)
    }

    // ---- 2. callback: exchange code → store the Auth0 refresh token in a sealed cookie ----
    if (path.endsWith('/callback')) {
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
      }
      const cookie = `${COOKIE}=${await seal(env.SESSION_SECRET, sess)}; HttpOnly; Secure; SameSite=Lax; Path=/agent; Max-Age=3600`
      return new Response(null, {
        status: 302,
        headers: { location: `${ORIGIN}/agent`, 'set-cookie': cookie },
      })
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

    // ---- 3. the real action: agent stars a repo on YOUR GitHub, after YOUR approval ----
    if (request.method === 'POST' && path.endsWith('/execute')) {
      if (!session) return json({ ok: false, reason: 'not_logged_in' }, 401)
      const b = (await request.json().catch(() => ({}))) as { repo?: string; decision?: string }
      const repo = cleanRepo(b.repo)
      if (!repo) return json({ ok: false, reason: 'invalid_repo' }, 400)
      const decision = b.decision === 'approved' ? 'approved' : 'denied'

      const audit: unknown[] = []
      const nominee: Nominee = new Nominee({
        // THE point: nominee fetches a fresh GitHub token for THIS user from Auth0 Token Vault
        strategy: Auth0({
          domain: env.AUTH0_DOMAIN,
          clientId: env.AUTH0_CLIENT_ID,
          clientSecret: env.AUTH0_CLIENT_SECRET,
          subjectToken: () => session.refreshToken,
          subjectTokenType: 'refresh_token',
        }),
        onApprovalRequest: (req) => {
          nominee.resolveApproval(req.id, decision)
        },
        onAudit: (e) => audit.push(e),
        agent: 'github-agent',
      })

      try {
        await nominee.approve({ user: session.sub, action: 'github.star', detail: { repo } })
      } catch {
        return json({ ok: true, decision, starred: false, audit })
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

      const gh = await fetch(`https://api.github.com/user/starred/${repo}`, {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'user-agent': 'nominee-demo',
          'content-length': '0',
        },
      })
      return json({ ok: gh.ok, decision, starred: gh.ok, status: gh.status, repo, audit })
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
    <p class="lede">Connect your GitHub through Auth0. nominee then fetches a <em>fresh</em> token for <strong>your</strong> account from Token Vault at the moment of the action — and only after <strong>you</strong> approve it.</p>
    <a class="primary" href="/agent/login">Connect GitHub via Auth0 →</a>
    <p class="foot" style="margin-top:24px">You grant access once (real OAuth consent). The agent never sees your password or stores your token.</p>`
  const loggedIn = `
    <p class="lede">Connected as <strong>${escape(session?.name || session?.sub || 'you')}</strong>. Ask the agent to star a repo <em>on your account</em>. Nothing happens until you approve — then nominee pulls your token from Token Vault and acts. <a href="/agent/logout">log out</a></p>
    <div class="card">
      <label for="repo">Repo to star (on your GitHub)</label>
      <input id="repo" type="text" value="bharath31/nominee" />
      <div class="row"><button id="run" class="primary">Ask agent to star it ▸</button><span id="status" class="sub"></span></div>
    </div>
    <div id="proposal" class="card" hidden></div>
    <div id="result" class="card" hidden></div>`
  return html(session ? loggedIn : loggedOut, Boolean(session))
}

const escape = (s: string) =>
  s.replace(/[&<>]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[m] as string)

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
  const repo=$('#repo').value.trim()
  $('#proposal').hidden=false
  $('#proposal').innerHTML='<label>Agent proposes</label><div class="log"><span class="ac">github.star</span> '+esc(repo)+' <span class="m">— on your account</span></div><p class="sub">Sensitive: nominee is holding it for your approval.</p><div class="row"><button class="approve" id="ap">✓ Approve</button><button class="deny" id="dn">Deny</button></div>'
  $('#ap').onclick=()=>go(repo,'approved');$('#dn').onclick=()=>go(repo,'denied')
}
async function go(repo,decision){
  $('#ap').disabled=true;$('#dn').disabled=true
  if(decision==='approved')$('#ap').innerHTML='starring…'
  const r=await fetch('/agent/execute',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({repo,decision})});const res=await r.json();J=res
  $('#result').hidden=false
  let log=line('m','$ approval '+decision)
  if(decision==='approved'&&res.starred){log+=line('ac','⚸ you approved');log+=line('ok','✓ nominee pulled a fresh token from Auth0 Token Vault');log+=line('ok','✓ starred '+esc(res.repo)+' on your GitHub — check your stars ★')}
  else if(decision==='denied'){log+=line('err','✗ denied — nothing happened on your account')}
  else{log+=line('err','✗ '+esc(res.reason||'failed')+(res.status?' ('+res.status+')':''))}
  log+='\\n'+line('m','audit  '+((res.audit||[]).map(e=>e.type).join(' → ')||'—'))
  $('#result').innerHTML='<label>Result</label><div class="log">'+log+'</div>'+jb()
  $('#ap').innerHTML='✓ Approve'
}
</script>`
}
