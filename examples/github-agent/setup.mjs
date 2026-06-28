#!/usr/bin/env node
// One-command setup for the github-agent example.
//
//   node setup.mjs            install CLIs, provision Auth0 + AI Gateway, write .env.local
//   node setup.mjs --dry-run  print the plan; run nothing, write nothing
//
// What it does (each external step is guarded and clearly announced):
//   1. preflight  — install vercel/auth0/gh CLIs if missing, log you in
//   2. AI Gateway — `eve link` for the model credential (or an AI_GATEWAY_API_KEY)
//   3. GitHub App — OAuth App client id/secret for the Auth0 connection
//   4. Auth0 app  — a Regular Web App (Authorization Code + Refresh Token)
//   5. connection — GitHub social connection with Token Vault enabled
//   6. CIBA       — enable the CIBA grant on the app
//   7. consent    — one browser pop to mint the user's refresh token + sub
//   8. write .env.local — merges AUTH0_* (+ key) into the file Eve reads
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
    plan('ensure auth0 CLI (brew install auth0/auth0-cli/auth0)')
    plan('ensure gh CLI (brew install gh)')
    plan('auth0 login / gh auth login if needed')
    return
  }
  ensureCli('vercel', { npm: 'vercel', manual: 'npm i -g vercel' })
  ensureCli('auth0', {
    brew: 'auth0/auth0-cli/auth0',
    manual: 'brew install auth0/auth0-cli/auth0',
  })
  ensureCli('gh', { brew: 'gh', manual: 'brew install gh (or see https://cli.github.com)' })
  ensureLogin('auth0', ['apps', 'list', '--json-compact'], ['login'], 'Auth0 CLI')
  ensureLogin('gh', ['auth', 'status'], ['auth', 'login'], 'GitHub CLI')
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
function auth0App() {
  step('Auth0 — create the Regular Web App')
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
  if (!DRY_RUN) ok(`Created app ${app.client_id}`)
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
function githubConnection(appClientId, gh) {
  step('Auth0 — GitHub connection with Token Vault')
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
  } catch (e) {
    warn(
      'Could not create the connection automatically (it may already exist or need ' +
        'Token Vault enabled in the dashboard). Configure it manually:\n' +
        '      Auth0 Dashboard → Authentication → Social → GitHub →\n' +
        '      enable Token Vault / Connected Accounts, scopes read:user + repo.',
    )
  }
}

// ── 6. CIBA grant ───────────────────────────────────────────────────────────
function enableCiba(appClientId) {
  step('Auth0 — enable CIBA (human-in-the-loop approval)')
  const body = JSON.stringify({
    grant_types: ['authorization_code', 'refresh_token', 'urn:openid:params:grant-type:ciba'],
  })
  try {
    sh('auth0', ['api', 'patch', `clients/${appClientId}`, '--data', body])
    if (!DRY_RUN) ok('CIBA grant enabled')
  } catch {
    warn('Could not enable CIBA automatically — add the CIBA grant on the app in the dashboard.')
  }
}

// ── 7. consent (browser pop) ────────────────────────────────────────────────
async function consent(domain, clientId, clientSecret) {
  step('Consent — one click to mint your refresh token')
  const authorizeUrl = `https://${domain}/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(CALLBACK_URL)}&scope=${encodeURIComponent('openid profile offline_access')}&connection=github&prompt=consent`

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
  console.log(c.bold(`\nnominee github-agent setup${DRY_RUN ? c.dim('  (dry run)') : ''}`))

  await preflight()
  const existing = { ...readExistingEnv(), ...process.env }
  const aiKey = await aiGatewayKey(existing)

  const domain = tenantDomain()
  const gh = await githubOAuthApp(domain)
  const { clientId, clientSecret } = auth0App()
  githubConnection(clientId, gh)
  enableCiba(clientId)
  const { refreshToken, sub } = await consent(domain, clientId, clientSecret)

  writeEnv({
    AI_GATEWAY_API_KEY: aiKey,
    AUTH0_DOMAIN: domain,
    AUTH0_CLIENT_ID: clientId,
    AUTH0_CLIENT_SECRET: clientSecret,
    AUTH0_REFRESH_TOKEN: refreshToken,
    AUTH0_USER_SUB: sub,
  })

  console.log(c.green(`\n✓ Done. Next: ${c.bold('pnpm dev')}\n`))
}

main()
  .catch((err) => {
    console.error(c.red(`\nSetup failed: ${err.message}\n`))
    process.exitCode = 1
  })
  .finally(() => rl.close())
