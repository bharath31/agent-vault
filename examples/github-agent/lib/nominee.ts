import { Nominee } from 'nominee'
import { requestAccess } from './broker.js'

// LEVEL 2 — with nominee (works for everybody).
//
// nominee's job: get a valid merge-access token at the *moment* the agent acts,
// never hold one across a pause. The strategy requests fresh just-in-time access
// from the broker on every call; because the token is short-lived, nominee never
// caches it — so a merge always runs with access that is valid right now.
export const nominee = new Nominee({
  strategy: async () => {
    const { token, expiresAt } = await requestAccess()
    return { token, expiresAt }
  },
  agent: 'github-agent',
})
