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
// With --auth0 (needs an Auth0 tenant with Token Vault + CIBA):
//   4. GitHub App — OAuth App client id/secret for the Auth0 connection
//   5. Auth0 app  — a Regular Web App (Authorization Code + Refresh Token)
//   6. connection — GitHub social connection with Token Vault enabled
//   7. CIBA       — enable the CIBA grant on the app
//   8. consent    — one browser pop to mint the user's refresh token + sub
//
// The Token Vault connection step is finicky and tenant-dependent; if the API
// call fails the script prints the exact manual fallback instead of dying.

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
const APP_NAME = 'nominee-github-agent'
const CALLBACK_PORT = 4777
const CALLBACK_URL = `http://localhost:${CALLBACK_PORT}/callback`

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
function githubToken() {
  step('GitHub token — Level 2 credential')
  if (DRY_RUN) {
    plan('GITHUB_TOKEN = $(gh auth token)')
    return ''
  }
  const token = sh('gh', ['auth', 'token'])
  ok('Captured a GitHub token from the gh CLI')
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
  const existing = (Array.isArray(list) ? list : []).find((a) => a.name === APP_NAME)
  if (existing) {
    const full = shJson('auth0', ['apps', 'show', existing.client_id, '--reveal-secrets', '--json'])
    // Make sure the localhost callback is present for the consent step.
    if (!(full.callbacks ?? []).includes(CALLBACK_URL)) {
      sh('auth0', [
        'apps',
        'update',
        existing.client_id,
        '--callbacks',
        [...(full.callbacks ?? []), CALLBACK_URL].join(','),
        '--json',
      ])
    }
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
    CALLBACK_URL,
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

// ── 7. consent (browser pop) ────────────────────────────────────────────────
async function consent(domain, clientId, clientSecret) {
  step('Consent — one click to mint your refresh token')
  // The My Account API audience is REQUIRED here: many tenants set a default
  // audience with offline_access disabled, which silently suppresses the refresh
  // token. Requesting `https://<domain>/me/` explicitly (with offline_access)
  // guarantees a refresh token — the same trick the live nominee.dev/agent worker
  // uses. That refresh token is what nominee exchanges for a GitHub Token Vault
  // token at call time.
  const audience = `https://${domain}/me/`
  const authorizeUrl = `https://${domain}/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(CALLBACK_URL)}&scope=${encodeURIComponent('openid profile email offline_access')}&audience=${encodeURIComponent(audience)}&connection=github&prompt=consent`

  if (DRY_RUN) {
    plan(`open browser → ${authorizeUrl}`)
    plan(`listen on ${CALLBACK_URL}, exchange code at https://${domain}/oauth/token`)
    return { refreshToken: '<refresh-token>', sub: '<auth0|user-sub>' }
  }

  return await new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url, CALLBACK_URL)
      if (url.pathname !== '/callback') {
        res.writeHead(404).end()
        return
      }
      const code = url.searchParams.get('code')
      if (!code) {
        res.writeHead(400).end('Missing code')
        return
      }
      try {
        const tokenRes = await fetch(`https://${domain}/oauth/token`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            grant_type: 'authorization_code',
            client_id: clientId,
            client_secret: clientSecret,
            code,
            redirect_uri: CALLBACK_URL,
          }),
        })
        const tok = await tokenRes.json()
        if (!tokenRes.ok) throw new Error(tok.error_description || JSON.stringify(tok))
        if (!tok.refresh_token) {
          // Don't silently write a partial config — surface the real problem.
          throw new Error(
            'no refresh_token returned. Your tenant likely suppresses offline_access on the default audience. ' +
              'Ensure the My Account API allows offline_access, then re-run `pnpm setup:auth0`.',
          )
        }
        const sub = decodeJwtSub(tok.id_token)
        res
          .writeHead(200, { 'content-type': 'text/html' })
          .end('<h2>✓ Connected. You can close this tab and return to the terminal.</h2>')
        server.close()
        resolve({ refreshToken: tok.refresh_token, sub })
      } catch (err) {
        res.writeHead(500).end('Token exchange failed')
        server.close()
        reject(err)
      }
    })
    server.listen(CALLBACK_PORT, () => {
      console.log(c.dim('    Opening your browser to approve GitHub access…'))
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
  const ghToken = githubToken()
  const env = { AI_GATEWAY_API_KEY: aiKey, GITHUB_TOKEN: ghToken }

  // Level 3 — Auth0 Token Vault + CIBA. Only with --auth0.
  if (WITH_AUTH0) {
    const domain = tenantDomain()
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
  .finally(() => rl.close())
