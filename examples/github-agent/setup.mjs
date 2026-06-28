#!/usr/bin/env node
// One-command setup for the github-agent example.
//
//   node setup.mjs            Levels 1 & 2: model credential + a real GitHub token
//   node setup.mjs --auth0    also Level 3: Auth0 Token Vault + CIBA
//   node setup.mjs --dry-run  print the plan; run nothing, write nothing
//
// Default (works for everybody):
//   1. preflight  — install vercel/gh CLIs if missing, log you in
//   2. AI Gateway — `eve link` for the model credential (or an AI_GATEWAY_API_KEY)
//   3. GitHub     — capture a real token from `gh auth token` (GITHUB_TOKEN)
//   -. write .env.local
//
// With --auth0 (needs an Auth0 tenant with Token Vault + CIBA + the My Account API —
// these are advanced/entitlement-gated features, not on free/trial tenants):
//   - Auth0 app  — a Regular Web App, reused if it already exists
//   - connection — reuse an existing Token Vault github connection, or create one
//                  (which prompts for a GitHub OAuth App's client id/secret)
//   - grants     — federated-connection (Token Vault) + CIBA (+ guardian-push channel)
//   - My Account — client-grant (subject_type=user) + MRRT policy for the /me/ API
//   - consent    — log in, then vault GitHub via the Connected Accounts flow
//   - verify     — confirm the vaulted token can actually merge the testbed repo
//
// Note on the connection's GitHub backing: a GitHub *App* (used by the live demo)
// issues refresh tokens so Token Vault genuinely refreshes, but needs to be
// *installed* on the repo with contents+pull_requests write to merge. A GitHub
// *OAuth App* with the `repo` scope merges public repos directly (no install) but
// its token is non-expiring (so it brokers, rather than refreshes, the token).

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { stdin as input, stdout as output, platform } from 'node:process'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DRY_RUN = process.argv.includes('--dry-run')
const WITH_AUTH0 = process.argv.includes('--auth0')

// Fail early with a clear message instead of a cryptic Eve/tsx crash later.
if (Number(process.versions.node.split('.')[0]) < 24) {
  console.error(
    `\nThis example needs Node 24+ (you have ${process.versions.node}).\nRun \`nvm use\` (or \`nvm install 24\`) in examples/github-agent, then retry.\n`,
  )
  process.exit(1)
}
const APP_NAME = 'nominee-github-agent'
const CALLBACK_PORT = 4777
const CALLBACK_URL = `http://localhost:${CALLBACK_PORT}/callback`
const CONNECT_CALLBACK_URL = `http://localhost:${CALLBACK_PORT}/connect/callback`

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
}

let stepN = 0
const step = (title) => console.log(`\n${c.bold(`[${++stepN}] ${title}`)}`)
const plan = (cmd) => console.log(c.dim(`    → ${cmd}`))
const ok = (msg) => console.log(c.green(`    ✓ ${msg}`))
const warn = (msg) => console.log(c.red(`    ! ${msg}`))

const rl = createInterface({ input, output })
const ask = (q) => rl.question(c.cyan(`    ? ${q} `))

/** Run a CLI command. In --dry-run, print and return ''. */
function sh(cmd, args, { capture = true } = {}) {
  if (DRY_RUN) {
    plan(`${cmd} ${args.join(' ')}`)
    return ''
  }
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' }).trim()
}

function shJson(cmd, args) {
  const out = sh(cmd, args)
  if (DRY_RUN || !out) return {}
  try {
    return JSON.parse(out)
  } catch {
    return {}
  }
}

function has(cmd, args = ['--version']) {
  try {
    execFileSync(cmd, args, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function openBrowser(url) {
  const opener = platform === 'darwin' ? 'open' : platform === 'win32' ? 'start' : 'xdg-open'
  try {
    execFileSync(opener, [url], { stdio: 'ignore' })
  } catch {
    warn(`Could not open a browser automatically. Open this URL manually:\n      ${url}`)
  }
}

/** Ensure a CLI exists, installing it if missing. `npm` installs cross-platform;
 *  otherwise we use Homebrew on macOS. Exits with a clear message if it can't. */
function ensureCli(name, { npm, brew, manual }) {
  if (has(name)) {
    ok(`${name} present`)
    return
  }
  console.log(c.dim(`    ${name} not found — installing…`))
  try {
    if (npm) execFileSync('npm', ['install', '-g', npm], { stdio: 'inherit' })
    else if (platform === 'darwin' && has('brew'))
      execFileSync('brew', ['install', brew], { stdio: 'inherit' })
    else throw new Error('no installer')
  } catch {
    // fall through to the check below
  }
  if (!has(name)) {
    warn(`Could not install ${name} automatically. Install it and re-run:\n      ${manual}`)
    process.exit(1)
  }
  ok(`${name} installed`)
}

function ensureLogin(name, checkArgs, loginArgs, label) {
  try {
    execFileSync(name, checkArgs, { stdio: 'ignore' })
    ok(`${label} logged in`)
  } catch {
    warn(`${label} not logged in — launching \`${name} ${loginArgs.join(' ')}\``)
    sh(name, loginArgs, { capture: false })
  }
}

// ── 1. preflight ────────────────────────────────────────────────────────────
async function preflight() {
  step('Preflight — install & check CLIs')
  if (DRY_RUN) {
    plan('ensure vercel CLI (npm i -g vercel)')
    plan('ensure gh CLI (brew install gh)')
    if (WITH_AUTH0) plan('ensure auth0 CLI (brew install auth0/auth0-cli/auth0)')
    plan(`vercel / gh login if needed${WITH_AUTH0 ? ' + auth0 login' : ''}`)
    return
  }
  ensureCli('vercel', { npm: 'vercel', manual: 'npm i -g vercel' })
  ensureCli('gh', { brew: 'gh', manual: 'brew install gh (or see https://cli.github.com)' })
  ensureLogin('gh', ['auth', 'status'], ['auth', 'login'], 'GitHub CLI')
  if (WITH_AUTH0) {
    ensureCli('auth0', {
      brew: 'auth0/auth0-cli/auth0',
      manual: 'brew install auth0/auth0-cli/auth0',
    })
    ensureLogin('auth0', ['apps', 'list', '--json-compact'], ['login'], 'Auth0 CLI')
  }
}

// ── GitHub token (Level 2 — works for everybody) ─────────────────────────────
async function githubToken() {
  step('GitHub token — Level 2 credential')
  if (DRY_RUN) {
    plan('GITHUB_TOKEN = $(gh auth token)')
    plan('verify it can merge (repo scope)')
    return ''
  }
  const token = sh('gh', ['auth', 'token'])
  // Verify it can merge up front — otherwise a reduced-scope token 403s cryptically
  // at merge time. (Default `gh auth login` includes `repo`; fine-grained PATs may not.)
  try {
    const u = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'nominee-setup' },
    })
    const scopes = u.headers.get('x-oauth-scopes') || ''
    if (scopes && !/\b(repo|public_repo)\b/.test(scopes)) {
      warn(
        `Your gh token scopes are '${scopes}' — merging needs 'repo'. If a merge 403s,\n      run: gh auth refresh -h github.com -s repo`,
      )
    } else {
      ok('Captured a GitHub token from the gh CLI (can merge)')
    }
  } catch {
    ok('Captured a GitHub token from the gh CLI')
  }
  return token
}

// ── 2. AI Gateway ───────────────────────────────────────────────────────────
async function aiGatewayKey(existing) {
  step('Vercel AI Gateway — model credential')
  if (existing.AI_GATEWAY_API_KEY || existing.VERCEL_OIDC_TOKEN) {
    ok('Gateway credential already present')
    return existing.AI_GATEWAY_API_KEY ?? ''
  }
  if (DRY_RUN) {
    plan('eve link  (Vercel login → AI Gateway access)')
    plan('fallback: prompt for AI_GATEWAY_API_KEY (https://vercel.com/dashboard/ai/api-keys)')
    return ''
  }
  console.log(c.dim('    Linking to Vercel for AI Gateway access (opens a browser to log in)…'))
  try {
    execFileSync('pnpm', ['exec', 'eve', 'link'], { stdio: 'inherit', cwd: HERE })
    ok('Linked to Vercel — AI Gateway ready')
    return '' // `eve link` manages the credential itself
  } catch {
    warn(
      '`eve link` did not complete. Paste a key instead (https://vercel.com/dashboard/ai/api-keys).',
    )
    const key = (await ask('AI_GATEWAY_API_KEY:')).trim()
    return key
  }
}

// ── 3. GitHub OAuth App ─────────────────────────────────────────────────────
async function githubOAuthApp(domain) {
  step('GitHub OAuth App — credentials for the Auth0 connection')
  const cb = `https://${domain}/login/callback`
  if (DRY_RUN) {
    plan(`create a GitHub OAuth App with callback ${cb}`)
    plan('https://github.com/settings/applications/new')
    return { id: '<github-client-id>', secret: '<github-client-secret>' }
  }
  console.log(
    c.dim(
      `    Create a GitHub OAuth App (one-time):\n      https://github.com/settings/applications/new\n      Homepage URL:    https://nominee.dev\n      Callback URL:    ${cb}`,
    ),
  )
  const id = (await ask('GitHub OAuth App Client ID:')).trim()
  const secret = (await ask('GitHub OAuth App Client Secret:')).trim()
  return { id, secret }
}

// ── 4. Auth0 app ────────────────────────────────────────────────────────────
// Reuse an existing app of the same name (so re-running setup doesn't pile up
// duplicate apps), otherwise create one.
function auth0App() {
  step('Auth0 — create/reuse the Regular Web App')
  if (DRY_RUN) {
    plan(`reuse or create app "${APP_NAME}" (callback ${CALLBACK_URL})`)
    return { clientId: '<client-id>', clientSecret: '<client-secret>' }
  }
  const list = shJson('auth0', ['apps', 'list', '--json'])
  const wanted = [CALLBACK_URL, CONNECT_CALLBACK_URL]
  const existing = (Array.isArray(list) ? list : []).find((a) => a.name === APP_NAME)
  if (existing) {
    const full = shJson('auth0', ['apps', 'show', existing.client_id, '--reveal-secrets', '--json'])
    // Make sure BOTH localhost callbacks (login + connect) are present.
    const cbs = new Set([...(full.callbacks ?? []), ...wanted])
    sh('auth0', ['apps', 'update', existing.client_id, '--callbacks', [...cbs].join(','), '--json'])
    ok(`Reusing app ${existing.client_id}`)
    return { clientId: existing.client_id, clientSecret: full.client_secret }
  }
  const app = shJson('auth0', [
    'apps',
    'create',
    '--name',
    APP_NAME,
    '--type',
    'regular',
    '--callbacks',
    wanted.join(','),
    '--reveal-secrets',
    '--json',
  ])
  ok(`Created app ${app.client_id}`)
  return {
    clientId: app.client_id ?? '<client-id>',
    clientSecret: app.client_secret ?? '<client-secret>',
  }
}

function tenantDomain() {
  const list = shJson('auth0', ['tenants', 'list', '--json'])
  const tenants = Array.isArray(list) ? list : (list.tenants ?? [])
  const active = tenants.find((t) => t.active) ?? tenants[0]
  return active?.name ?? active?.domain ?? '<your-tenant>.us.auth0.com'
}

// One clear plan check instead of a cascade of cryptic step failures. Token Vault
// (Connected Accounts) is gated behind the My Account API resource server; if the
// tenant doesn't have it, Level 3 cannot work — say so once and stop.
function checkEntitlements(domain) {
  step('Auth0 — plan check (Token Vault + CIBA + My Account API)')
  if (DRY_RUN) {
    plan(
      `auth0 api get resource-servers → confirm the My Account API (https://${domain}/me/) exists`,
    )
    return
  }
  const servers = shJson('auth0', ['api', 'get', 'resource-servers'])
  const list = Array.isArray(servers) ? servers : []
  const hasMyAccount = list.some((s) => s.identifier === `https://${domain}/me/`)
  if (!hasMyAccount) {
    warn(
      `This Auth0 tenant (${domain}) does not have the My Account API / Token Vault.\n      Level 3 needs an Auth0 plan with Token Vault + CIBA + the My Account API — these\n      are advanced features, not on free/trial tenants (see README → Prerequisites).\n\n      Levels 1 & 2 work for everybody with no Auth0 — run:  pnpm setup  (no --auth0).`,
    )
    process.exit(1)
  }
  ok('Tenant has the My Account API — Token Vault is available')
}

// ── 5. GitHub social connection with Token Vault ────────────────────────────
// The reliable path: REUSE an existing Token Vault-enabled `github` connection if
// the tenant already has one (so we don't depend on getting a fresh connection's
// Token Vault config exactly right). Only create one when none exists.
function findGithubConnection() {
  if (DRY_RUN) return null
  const conns = shJson('auth0', ['api', 'get', 'connections'])
  const list = Array.isArray(conns) ? conns : []
  return list.find((conn) => conn.strategy === 'github') ?? null
}

function enableAppOnConnection(conn, appClientId) {
  step('Auth0 — reuse existing GitHub Token Vault connection')
  const enabled = new Set(conn.enabled_clients ?? [])
  enabled.add(appClientId)
  sh('auth0', [
    'api',
    'patch',
    `connections/${conn.id}`,
    '--data',
    JSON.stringify({ enabled_clients: [...enabled] }),
  ])
  if (!DRY_RUN) ok(`Enabled this app on existing github connection "${conn.name}"`)
  // Heads-up early if the reused connection is OAuth-app-backed and scoped too
  // narrowly to merge (e.g. a gists/read-only demo). For GitHub-App-backed
  // connections scope is moot — permissions come from the App (verifyVault checks).
  const scope = conn.options?.scope
  if (Array.isArray(scope) && !scope.some((s) => s === 'repo' || s === 'public_repo')) {
    warn(
      `Reused connection "${conn.name}" is scoped [${scope.join(', ')}] — merging needs 'repo'/'public_repo'.\n      If it is OAuth-app-backed, widen the scope (Authentication → Social → GitHub). If it is\n      GitHub-App-backed, scope is moot — the verify step checks the app’s repo permissions.`,
    )
  }
}

function createGithubConnection(appClientId, gh) {
  step('Auth0 — create GitHub connection with Token Vault')
  const body = JSON.stringify({
    name: 'github',
    strategy: 'github',
    options: {
      client_id: gh.id,
      client_secret: gh.secret,
      scope: ['read:user', 'repo'],
      // Connected Accounts / Token Vault: federated token exchange enabled.
      federated_connections_access_tokens: { active: true },
    },
    enabled_clients: [appClientId],
  })
  try {
    sh('auth0', ['api', 'post', 'connections', '--data', body])
    if (!DRY_RUN) ok('GitHub connection created with Token Vault enabled')
  } catch {
    warn(
      'Could not create the github connection automatically. Enable Token Vault in the\n' +
        '      dashboard (Authentication → Social → GitHub → Token Vault), then re-run.',
    )
  }
}

// ── 6. grants (Token Vault federated exchange + CIBA) ────────────────────────
// These two grants are what make Level 3 work, and BOTH are required:
//   - the federated-connection token-exchange grant lets nominee pull a fresh
//     GitHub token from Token Vault (`nominee.token`)
//   - the CIBA grant lets nominee push the approval to your phone (`nominee.approve`)
// (Verified against the working nominee.dev/agent app, which carries exactly these.)
function enableGrants(appClientId) {
  step('Auth0 — enable Token Vault + CIBA grants')
  const body = JSON.stringify({
    grant_types: [
      'authorization_code',
      'refresh_token',
      'client_credentials',
      'urn:auth0:params:oauth:grant-type:token-exchange:federated-connection-access-token',
      'urn:openid:params:grant-type:ciba',
    ],
    // CIBA requires a notification channel — Auth0 rejects the grant without it.
    async_approval_notification_channels: ['guardian-push'],
  })
  try {
    sh('auth0', ['api', 'patch', `clients/${appClientId}`, '--data', body])
    if (!DRY_RUN) ok('Token Vault (federated exchange) + CIBA grants enabled')
  } catch {
    warn(
      'Could not set grants automatically — add the federated-connection and CIBA grants in the dashboard.',
    )
  }
}

// ── 6b. My Account API authorization (so offline_access yields a usable token) ─
// The consent requests the My Account audience to dodge tenant default-audience
// offline_access suppression. For that to be allowed, the app must (1) hold a
// client grant for the /me/ API and (2) carry a matching multi-resource
// refresh-token (MRRT) policy — exactly what the live nominee.dev/agent app has.
function authorizeMyAccount(appClientId, domain) {
  step('Auth0 — authorize the app for the My Account API (MRRT)')
  const audience = `https://${domain}/me/`
  const scope = [
    'create:me:connected_accounts',
    'read:me:connected_accounts',
    'delete:me:connected_accounts',
  ]
  try {
    // subject_type MUST be 'user' — the refresh token is minted in the user
    // authorize flow, not a machine (client_credentials) flow. A 'client' grant
    // leaves the authorize unauthorized for the /me/ audience.
    sh('auth0', [
      'api',
      'post',
      'client-grants',
      '--data',
      JSON.stringify({ client_id: appClientId, audience, scope, subject_type: 'user' }),
    ])
  } catch {
    // Likely already granted on a re-run — fine.
  }
  const refresh_token = {
    expiration_type: 'non-expiring',
    rotation_type: 'non-rotating',
    leeway: 0,
    token_lifetime: 2592000,
    idle_token_lifetime: 1296000,
    infinite_token_lifetime: true,
    infinite_idle_token_lifetime: true,
    policies: [{ audience, scope }],
  }
  try {
    sh('auth0', [
      'api',
      'patch',
      `clients/${appClientId}`,
      '--data',
      JSON.stringify({ refresh_token }),
    ])
    if (!DRY_RUN) ok('Authorized for My Account API + MRRT policy set')
  } catch {
    warn(
      'Could not authorize the app for the My Account API — set it in the dashboard, then re-run.',
    )
  }
}

// The page shown in the browser after the consent redirect. `error` renders the
// failure variant.
function connectedPage(error) {
  const ok = !error
  const accent = ok ? '#22c55e' : '#f87171'
  const ring = ok ? 'rgba(34,197,94,0.15)' : 'rgba(248,113,113,0.12)'
  const icon = ok ? '✓' : '✕'
  const title = ok ? 'GitHub connected' : 'Connection failed'
  const body = ok
    ? 'Your Token Vault grant is set. Close this tab and return to your terminal.'
    : escapeHtml(String(error))
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>nominee — ${ok ? 'connected' : 'error'}</title>
<style>
  :root { color-scheme: dark }
  * { box-sizing: border-box }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    background: radial-gradient(1100px 560px at 50% -12%, #1b1320, #0a0a0f); color:#ece8e1 }
  .card { text-align:center; padding:44px 40px; max-width:440px; margin:24px;
    background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08);
    border-radius:18px }
  .badge { width:60px; height:60px; margin:0 auto 22px; border-radius:50%;
    display:grid; place-items:center; font-size:30px; color:${accent};
    background:${ring}; border:1px solid ${accent}55 }
  h1 { font-size:20px; font-weight:650; margin:0 0 10px; letter-spacing:-0.01em }
  p { margin:0; color:#a8a29a; font-size:14px; line-height:1.55 }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    background:rgba(255,255,255,0.06); padding:2px 7px; border-radius:6px; color:#ece8e1 }
  .brand { margin-top:26px; font-size:11px; letter-spacing:0.14em; text-transform:uppercase; color:#6b655c }
</style></head>
<body><div class="card">
  <div class="badge">${icon}</div>
  <h1>${title}</h1>
  <p>${ok ? 'Your Token Vault grant is set. Close this tab and return to your terminal — then run <code>pnpm dev</code>.' : body}</p>
  <div class="brand">nominee</div>
</div></body></html>`
}

function escapeHtml(s) {
  return s.replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch],
  )
}

// Tiny shim: Auth0 returns connect_code in the URL fragment (not sent to the
// server), so this page reads it and re-requests with it in the query string.
function connectCodeShim() {
  return `<!doctype html><html><head><meta charset="utf-8"><title>completing…</title></head><body>
<script>
const m=location.hash.match(/connect_code=([^&]+)/)||location.search.match(/connect_code=([^&]+)/);
if(m){location.replace('/connect/callback?connect_code='+encodeURIComponent(m[1]));}
else{document.body.textContent='Missing connect_code — please re-run pnpm setup:auth0.';}
</script></body></html>`
}

// ── 7. consent + vault (browser) ─────────────────────────────────────────────
// Mirrors the live nominee.dev/agent worker: log in, then vault the GitHub token
// through the **Connected Accounts** flow. The primary login alone does NOT keep
// Token Vault fresh — only `/connect` + `/complete` store a refreshable token
// that the federated exchange (nominee.token) can actually use.
async function consent(domain, clientId, clientSecret) {
  step('Consent — log in, then vault your GitHub token (Connected Accounts)')
  const meAud = `https://${domain}/me/`
  const CA_SCOPE =
    'openid profile email offline_access create:me:connected_accounts read:me:connected_accounts delete:me:connected_accounts'
  // prompt=login forces a real re-auth (not an SSO replay); audience=me dodges
  // tenant default-audience offline_access suppression so we get a refresh token.
  const authorizeUrl = `https://${domain}/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(CALLBACK_URL)}&scope=${encodeURIComponent('openid profile email offline_access')}&audience=${encodeURIComponent(meAud)}&connection=github&prompt=login`

  if (DRY_RUN) {
    plan(`open browser → ${authorizeUrl}`)
    plan('exchange code → Auth0 refresh token (My Account audience)')
    plan('POST /me/v1/connected-accounts/connect → open GitHub authorize')
    plan('POST /me/v1/connected-accounts/complete → vault the GitHub token')
    return { refreshToken: '<refresh-token>', sub: '<auth0|user-sub>' }
  }

  return await new Promise((resolve, reject) => {
    // Shared across the two callbacks (login → connect).
    let refreshToken
    let sub
    let maToken
    let authSession

    const oauth = (body) =>
      fetch(`https://${domain}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    const me = (path, body) =>
      fetch(`https://${domain}/me/v1/connected-accounts${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${maToken}` },
        body: JSON.stringify(body),
      })

    const server = createServer(async (req, res) => {
      const fail = (err) => {
        const msg = err instanceof Error ? err.message : String(err)
        try {
          res.writeHead(500, { 'content-type': 'text/html; charset=utf-8' }).end(connectedPage(msg))
        } catch {}
        server.close()
        reject(new Error(msg))
      }
      try {
        const url = new URL(req.url, CALLBACK_URL)

        // 1. login callback → Auth0 refresh token, then initiate Connected Accounts connect.
        if (url.pathname === '/callback') {
          const code = url.searchParams.get('code')
          if (!code) {
            const d = url.searchParams.get('error_description') || 'No authorization code.'
            return fail(decodeURIComponent(d))
          }
          const tr = await oauth({
            grant_type: 'authorization_code',
            client_id: clientId,
            client_secret: clientSecret,
            code,
            redirect_uri: CALLBACK_URL,
          })
          const tok = await tr.json()
          if (!tr.ok) return fail(tok.error_description || JSON.stringify(tok))
          if (!tok.refresh_token) return fail('no refresh_token (offline_access suppressed)')
          refreshToken = tok.refresh_token
          sub = decodeJwtSub(tok.id_token)

          const mr = await oauth({
            grant_type: 'refresh_token',
            client_id: clientId,
            client_secret: clientSecret,
            refresh_token: refreshToken,
            audience: meAud,
            scope: CA_SCOPE,
          })
          const mj = await mr.json()
          if (!mj.access_token) return fail(`My Account token failed: ${JSON.stringify(mj)}`)
          maToken = mj.access_token

          // Clear any stale GitHub connected account first, so a re-run after a
          // permission change actually re-consents (otherwise GitHub silently
          // reuses the old, under-privileged grant). Mirrors the live worker's
          // /disconnect. Ignore failures (e.g. nothing connected yet).
          try {
            const lr = await fetch(`https://${domain}/me/v1/connected-accounts`, {
              headers: { authorization: `Bearer ${maToken}` },
            })
            if (lr.ok) {
              const lj = await lr.json()
              for (const acc of lj.connected_accounts ?? []) {
                if (acc.connection === 'github' && acc.id) {
                  await fetch(`https://${domain}/me/v1/connected-accounts/${acc.id}`, {
                    method: 'DELETE',
                    headers: { authorization: `Bearer ${maToken}` },
                  })
                }
              }
            }
          } catch {}

          const cr = await me('/connect', {
            connection: 'github',
            redirect_uri: CONNECT_CALLBACK_URL,
            scopes: ['public_repo'],
          })
          const cj = await cr.json()
          if (!cr.ok || !cj.connect_uri)
            return fail(`connect init failed (${cr.status}) ${JSON.stringify(cj)}`)
          authSession = cj.auth_session
          const ticket = cj.connect_params?.ticket
          const target = ticket
            ? `${cj.connect_uri}?ticket=${encodeURIComponent(ticket)}`
            : cj.connect_uri
          // Continue in the same browser tab: authorize GitHub for the vault.
          return res.writeHead(302, { location: target }).end()
        }

        // 2. connect callback → complete the flow, vaulting the GitHub token.
        if (url.pathname === '/connect/callback') {
          const connectCode = url.searchParams.get('connect_code')
          if (!connectCode) {
            // connect_code arrives in the fragment; shim re-requests with it in the query.
            return res
              .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
              .end(connectCodeShim())
          }
          const cr = await me('/complete', {
            auth_session: authSession,
            connect_code: connectCode,
            redirect_uri: CONNECT_CALLBACK_URL,
          })
          if (!cr.ok) return fail(`vault complete failed (${cr.status}) ${await cr.text()}`)
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(connectedPage())
          server.close()
          return resolve({ refreshToken, sub })
        }

        res.writeHead(404).end()
      } catch (err) {
        fail(err)
      }
    })
    server.listen(CALLBACK_PORT, () => {
      console.log(c.dim('    Opening your browser — log in, then approve GitHub access…'))
      openBrowser(authorizeUrl)
    })
  })
}

function decodeJwtSub(idToken) {
  if (!idToken) return ''
  try {
    const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8'))
    return payload.sub ?? ''
  } catch {
    return ''
  }
}

const ENV_PATH = join(HERE, '.env.local')

// ── verify the vaulted token can actually merge (catch perms at setup time) ───
// Turns the cryptic agent-time "403 Resource not accessible by integration" into
// an upfront, actionable message. Warns (never blocks) so .env.local is still
// written and you can fix the permission and re-run.
async function verifyVault(domain, clientId, clientSecret, refreshToken, targetRepo) {
  step('Verify — can the vaulted GitHub token merge?')
  if (DRY_RUN) {
    plan('federated exchange → confirm the GitHub token can merge on the testbed repo')
    return
  }
  try {
    const r = await fetch(`https://${domain}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type:
          'urn:auth0:params:oauth:grant-type:token-exchange:federated-connection-access-token',
        subject_token_type: 'urn:ietf:params:oauth:token-type:refresh_token',
        subject_token: refreshToken,
        requested_token_type: 'http://auth0.com/oauth/token-type/federated-connection-access-token',
        connection: 'github',
        client_id: clientId,
        client_secret: clientSecret,
      }),
    })
    const j = await r.json()
    const token = j.access_token
    if (!token) return warn(`Token Vault returned no token (${r.status}). Re-run setup.`)
    const ghHeaders = { Authorization: `Bearer ${token}`, 'User-Agent': 'nominee-setup' }
    const u = await fetch('https://api.github.com/user', { headers: ghHeaders })
    if (!u.ok) return warn(`Vaulted token is not valid (GitHub ${u.status}). Re-run setup.`)
    // OAuth App path: the `repo` scope merges directly, no installation needed.
    const scopes = u.headers.get('x-oauth-scopes') || ''
    if (/\b(repo|public_repo)\b/.test(scopes))
      return ok(`Vaulted token can merge (scope: ${scopes}).`)
    // GitHub App path: it's not enough that *some* install has write — the app must
    // be installed ON THE TARGET REPO with contents+pull_requests write, or the
    // merge 403s even though a global check would pass. Verify against targetRepo.
    const inst = await fetch('https://api.github.com/user/installations', { headers: ghHeaders })
    const ij = await inst.json().catch(() => ({}))
    const writeInstalls = (ij.installations || []).filter(
      (i) => i.permissions?.contents === 'write' && i.permissions?.pull_requests === 'write',
    )
    if (writeInstalls.length === 0) {
      return warn(
        'The vaulted token can READ but not MERGE. Grant write access, then re-run pnpm setup:auth0:\n' +
          '      • OAuth App: add the `repo` scope to the GitHub connection.\n' +
          '      • GitHub App: set Pull requests + Contents = Read & write (App → Permissions).',
      )
    }
    // Confirm one of those installs actually covers the target repo.
    let coversTarget = !targetRepo
    for (const i of writeInstalls) {
      if (coversTarget) break
      const reposRes = await fetch(
        `https://api.github.com/user/installations/${i.id}/repositories`,
        { headers: ghHeaders },
      )
      const rj = await reposRes.json().catch(() => ({}))
      if ((rj.repositories || []).some((r) => r.full_name === targetRepo)) coversTarget = true
    }
    if (coversTarget)
      return ok(`Vaulted GitHub App token can merge${targetRepo ? ` on ${targetRepo}` : ''}.`)
    warn(
      `The GitHub App has write permission but is NOT installed on ${targetRepo}.\n      Install it there (App → "Install App" tab → select the repo), disconnect the\n      GitHub connected account in Auth0, and re-run pnpm setup:auth0 to re-vault.`,
    )
  } catch (e) {
    warn(`Could not verify the vaulted token: ${e instanceof Error ? e.message : e}`)
  }
}

// ── 8. write .env.local ─────────────────────────────────────────────────────
// Eve reads `.env.local` (its candidates are ['.env.local', '.env']) and
// hot-reloads it. We MERGE so we never clobber what `eve link` wrote there.
function writeEnv(values) {
  step('Write .env.local')
  const provided = Object.fromEntries(Object.entries(values).filter(([, v]) => v))
  if (DRY_RUN) {
    plan(`merge into .env.local: ${Object.keys(provided).join(', ')}`)
    return
  }
  const merged = { ...readExistingEnv(), ...provided }
  const body = `${Object.entries(merged)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')}\n`
  writeFileSync(ENV_PATH, body)
  ok('.env.local written')
}

function readExistingEnv() {
  if (!existsSync(ENV_PATH)) return {}
  const env = {}
  for (const line of readFileSync(ENV_PATH, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (m?.[2]) env[m[1]] = m[2]
  }
  return env
}

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log(
    c.bold(
      `\nnominee github-agent setup${WITH_AUTH0 ? ' + Auth0' : ''}${DRY_RUN ? c.dim('  (dry run)') : ''}`,
    ),
  )

  await preflight()
  const existing = { ...readExistingEnv(), ...process.env }

  // Model credential (all levels) + GitHub token (Levels 1 & 2 — works for everybody).
  const aiKey = await aiGatewayKey(existing)
  const ghToken = await githubToken()
  const env = { AI_GATEWAY_API_KEY: aiKey, GITHUB_TOKEN: ghToken }

  // Level 3 — Auth0 Token Vault + CIBA. Only with --auth0.
  if (WITH_AUTH0) {
    const domain = tenantDomain()
    checkEntitlements(domain) // fail fast on free/trial tenants with one clear message
    const { clientId, clientSecret } = auth0App()
    const existingConn = findGithubConnection()
    if (existingConn) {
      // Reuse the tenant's working Token Vault github connection.
      enableAppOnConnection(existingConn, clientId)
    } else {
      // Fresh tenant: create the connection (needs a GitHub OAuth App).
      const gh = await githubOAuthApp(domain)
      createGithubConnection(clientId, gh)
    }
    enableGrants(clientId)
    authorizeMyAccount(clientId, domain)
    const { refreshToken, sub } = await consent(domain, clientId, clientSecret)
    // The repo the agent will merge — the same one `pnpm seed` targets — so the
    // verify step checks the App is installed where it actually matters.
    const ghLogin = shJson('gh', ['api', 'user']).login
    const targetRepo =
      process.env.TESTBED_REPO || (ghLogin ? `${ghLogin}/nominee-agent-testbed` : '')
    await verifyVault(domain, clientId, clientSecret, refreshToken, targetRepo)
    Object.assign(env, {
      AUTH0_DOMAIN: domain,
      AUTH0_CLIENT_ID: clientId,
      AUTH0_CLIENT_SECRET: clientSecret,
      AUTH0_REFRESH_TOKEN: refreshToken,
      AUTH0_USER_SUB: sub,
    })
  }

  writeEnv(env)
  console.log(
    c.green(
      `\n✓ Done. Seed a PR with ${c.bold('pnpm seed')}, then start with ${c.bold('pnpm dev')}.\n`,
    ),
  )
  if (!WITH_AUTH0) {
    console.log(c.dim('  For Level 3 (Auth0 Token Vault + CIBA): pnpm setup:auth0\n'))
  }
}

main()
  .catch((err) => {
    console.error(c.red(`\nSetup failed: ${err.message}\n`))
    process.exitCode = 1
  })
  .finally(() => {
    rl.close()
    // The consent step's localhost callback server can keep a browser keep-alive
    // socket open, holding the event loop. Exit explicitly so setup returns.
    process.exit(process.exitCode ?? 0)
  })
