# Minimal Vercel AI SDK drop-in

Drop nominee into any Vercel AI SDK tool in **one wrapper** — a fresh token at
call time, human approval, and an audit trail. No SaaS, no provider signup.

```bash
pnpm install
cp .env.example .env   # set GITHUB_TOKEN and OPENROUTER_API_KEY
node --env-file=.env --import tsx agent.ts
```

The whole integration is `nomineeTool({ ... })`:

```ts
const starRepo = nomineeTool({
  nominee,
  user: 'demo-user',
  connection: 'github',
  approval: true,            // gates execute behind a human OK
  action: 'star_repo',
  description: 'Star a GitHub repository on behalf of the user',
  inputSchema: z.object({ owner: z.string(), repo: z.string() }),
  async execute({ owner, repo }, { token }) {
    // `token` is fresh, resolved by nominee at this exact moment.
  },
})
```

You keep the AI SDK's tool-calling loop; nominee gives the tool a fresh token and
gates the sensitive call. The same `nominee` instance works in Eve or standalone.

> **OpenRouter gotcha:** use `openrouter.chat('openai/gpt-4o-mini')` — the
> provider's default endpoint isn't the chat-completions one OpenRouter expects.

## When you don't need this

If you're already on a managed connector (Vercel Connect, Auth0 Token Vault),
use it — you don't need nominee. This is for the framework-neutral, no-lock-in,
bring-your-own-token case.
