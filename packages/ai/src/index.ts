import { type Tool, type ToolCallOptions, tool } from 'ai'
import type { Nominee } from 'nominee'
import type { z } from 'zod'

/**
 * Resolves the principal the agent acts on behalf of. Either a fixed user id,
 * or a function of the AI SDK tool-call options.
 */
export type UserResolver = string | ((options: ToolCallOptions) => string | Promise<string>)

/** Augmented context passed to your `execute`, on top of the AI SDK's options. */
export interface NomineeAiContext {
  /** A fresh token for `connection`, fetched via your nominee strategy. */
  token?: string
  /** The resolved principal. */
  user: string
  /** The AI SDK's native tool-call options (toolCallId, messages, abortSignal). */
  ai: ToolCallOptions
}

export interface NomineeAiToolConfig<TSchema extends z.ZodType, TOutput> {
  /** The nominee instance whose strategy brokers tokens / approvals. */
  nominee: Nominee
  /** Who the agent acts for. */
  user: UserResolver
  /** Fetch a fresh token for this connection (e.g. `"github"`) before execute. */
  connection?: string
  /** Optional scopes to request for the token. */
  scopes?: string[]
  /**
   * Require human approval (via your nominee strategy — e.g. Auth0 CIBA push)
   * before running `execute`. Throws and aborts the tool call if denied.
   */
  approval?: boolean
  /** Action name used for the approval prompt and audit log. Defaults to `"tool"`. */
  action?: string
  description: string
  inputSchema: TSchema
  execute: (input: z.infer<TSchema>, ctx: NomineeAiContext) => TOutput | Promise<TOutput>
}

/**
 * Build a Vercel AI SDK tool whose token and human approval come from nominee.
 *
 * The AI SDK gives you the tool-calling loop; nominee gives the tool a *fresh*
 * third-party token (Auth0 Token Vault, a generic OAuth store, or any strategy)
 * at call time and gates sensitive calls behind provider-portable approval —
 * the same nominee instance you'd use in Eve or standalone.
 *
 * ```ts
 * import { nomineeTool } from 'nominee-ai'
 * import { z } from 'zod'
 *
 * const closeIssue = nomineeTool({
 *   nominee,
 *   user: 'user_123',
 *   connection: 'github',
 *   approval: true,
 *   action: 'close_issue',
 *   description: 'Close a GitHub issue',
 *   inputSchema: z.object({ repo: z.string(), issue: z.number() }),
 *   async execute({ repo, issue }, { token }) {
 *     // `token` is a fresh GitHub token, auto-refreshed by nominee
 *   },
 * })
 * ```
 */
export function nomineeTool<TSchema extends z.ZodType, TOutput>(
  config: NomineeAiToolConfig<TSchema, TOutput>,
): Tool<z.infer<TSchema>, TOutput> {
  const { nominee, action = 'tool' } = config

  const definition = {
    description: config.description,
    inputSchema: config.inputSchema,
    async execute(input: z.infer<TSchema>, options: ToolCallOptions): Promise<TOutput> {
      const user = typeof config.user === 'function' ? await config.user(options) : config.user

      if (config.approval) {
        // Throws ApprovalDeniedError if the human denies / it expires.
        await nominee.approve({ user, action, detail: input })
      }

      let token: string | undefined
      if (config.connection) {
        token = await nominee.token({ user, connection: config.connection, scopes: config.scopes })
      }

      return config.execute(input, { token, user, ai: options })
    },
  }

  // AI SDK v6's tool() generics don't unify with our Zod-inferred public API,
  // so we keep types correct at this boundary and hand tool() the definition.
  return tool(definition as unknown as Parameters<typeof tool>[0]) as unknown as Tool<
    z.infer<TSchema>,
    TOutput
  >
}

/**
 * Bind a nominee instance (and optional default user) once, returning a
 * `nomineeTool` you can call without repeating them.
 */
export function withNominee(nominee: Nominee, defaults?: { user?: UserResolver }) {
  return <TSchema extends z.ZodType, TOutput>(
    config: Omit<NomineeAiToolConfig<TSchema, TOutput>, 'nominee' | 'user'> & {
      user?: UserResolver
    },
  ) => {
    const user = config.user ?? defaults?.user
    if (user === undefined) {
      throw new Error(
        'nominee-ai: `user` is required (pass it here or as a default to withNominee)',
      )
    }
    return nomineeTool({ ...config, nominee, user } as NomineeAiToolConfig<TSchema, TOutput>)
  }
}
