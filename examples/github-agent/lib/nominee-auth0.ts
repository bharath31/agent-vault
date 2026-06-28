import { Nominee } from 'nominee'
import { auth0 } from 'nominee-auth0'

// LEVEL 3 — with nominee + Auth0.
//
// The token comes from Auth0 **Token Vault** and the approval is a **CIBA** push
// to your phone. Requires an Auth0 tenant with Token Vault + CIBA enabled (see
// the README prerequisites). `pnpm setup --auth0` provisions and configures it,
// writing the AUTH0_* vars into .env.local that auth0() reads.
export const nomineeAuth0 = new Nominee({ strategy: auth0(), agent: 'github-agent' })
