/**
 * A durable agent that survives hibernation — and so does its access.
 *
 * The agent runs as a Cloudflare Durable Object: it sleeps between steps and is
 * woken hours later by an alarm. The naive approach — grabbing a token when the
 * agent starts — breaks here: by the time the DO wakes, that access token has
 * long expired. nominee stores a *resolver*, not a token, so every wake
 * re-resolves a fresh one. The agent's step code never touches refresh logic.
 *
 * The one rule that makes this work: wire the strategy's credentials as
 * FUNCTIONS that read from durable storage (or your DB) — never capture a token
 * into the Durable Object's serialized state.
 */
import { Nominee, OAuth2 } from 'nominee'

export interface Env {
  AGENT: DurableObjectNamespace
  TOKEN_ENDPOINT: string
}

export class ResearchAgent {
  private readonly nominee: Nominee

  constructor(
    private readonly state: DurableObjectState,
    env: Env,
  ) {
    // Rebuilt on every wake. The refresh token is read from durable storage at
    // call time, so it survives hibernation. We never hold an access token on
    // `this` — nominee re-resolves it whenever a step runs.
    this.nominee = new Nominee({
      strategy: OAuth2({
        connections: {
          github: {
            tokenEndpoint: env.TOKEN_ENDPOINT,
            clientId: 'durable-agent',
            refreshToken: async () =>
              (await this.state.storage.get<string>('github_refresh_token')) ?? '',
          },
        },
      }),
      agent: 'research-agent',
    })
  }

  /** Start a long-running job: stash creds, schedule the first step. */
  async fetch(req: Request): Promise<Response> {
    const { refreshToken, user } = (await req.json()) as { refreshToken: string; user: string }
    await this.state.storage.put('github_refresh_token', refreshToken)
    await this.state.storage.put('user', user)
    await this.state.storage.setAlarm(Date.now() + 1_000)
    return Response.json({
      ok: true,
      message: 'agent scheduled — it will resume after hibernation',
    })
  }

  /**
   * Woken by the platform, possibly hours later. The DO had hibernated and any
   * token captured earlier is dead — but nominee gets a fresh one regardless.
   */
  async alarm(): Promise<void> {
    const user = (await this.state.storage.get<string>('user')) ?? 'unknown'

    // Always fresh. No 401, no refresh code in the agent — and if you'd swapped
    // OAuth2 for Auth0() above, this exact line would pull from Token Vault.
    const token = await this.nominee.token({ user, connection: 'github' })

    await fetch('https://api.github.com/user/repos', {
      headers: { authorization: `Bearer ${token}`, 'user-agent': 'nominee-durable-demo' },
    })

    // …do the next step, then sleep again until the next wake:
    // await this.state.storage.setAlarm(Date.now() + 3_600_000)
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const id = env.AGENT.idFromName('demo-session')
    return env.AGENT.get(id).fetch(req)
  },
}
