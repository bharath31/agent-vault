import { Nominee, type Strategy } from 'nominee'
import { auth0 } from 'nominee-auth0'

// LEVEL 3 — with nominee + Auth0.
//
// The token comes from Auth0 Token Vault and the approval is a CIBA push to your
// phone. Requires an Auth0 tenant with Token Vault + CIBA enabled (see the README
// prerequisites). `pnpm setup:auth0` provisions and configures it, writing the
// AUTH0_* vars into .env.local that auth0() reads.
//
// Built safely: a missing or partial Auth0 config must NOT crash the whole agent
// at boot — it should only surface when the Level-3 tool actually runs. So if
// auth0() can't be constructed yet, we fall back to a stub that throws the same
// message at call time (Levels 1 & 2 keep working).
function auth0Strategy(): Strategy {
  try {
    return auth0()
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return {
      name: 'auth0-unconfigured',
      getToken: () => Promise.reject(new Error(message)),
      requestApproval: () => Promise.reject(new Error(message)),
    }
  }
}

export const nomineeAuth0 = new Nominee({
  strategy: auth0Strategy(),
  agent: 'github-agent',
  // Safety net: if CIBA somehow isn't wired (e.g. AUTH0_USER_SUB missing), the
  // built-in approval engine would otherwise wait forever. Time out instead.
  approvalTimeoutMs: 120_000,
})
