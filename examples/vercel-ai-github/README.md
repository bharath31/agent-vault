# vercel-ai-github — nominee with the Vercel AI SDK

A real AI SDK agent. The model is asked to look at a repo's issues and then star
it. Two tools are wired through nominee:

- `getIssues` — a fresh GitHub token is injected into the tool, no approval.
- `starRepo` — same fresh token, **plus** a human approval gate before it runs.

The LLM decides which tools to call; nominee makes sure the token is fresh at the
moment each tool fires and pauses the sensitive one for approval.

## Run

```bash
pnpm install                       # from the repo root
export OPENAI_API_KEY=sk-...        # the model that drives the agent
pnpm --filter vercel-ai-github dev
```

(The GitHub token in this demo is mocked by the strategy — no real API calls —
so you only need an OpenAI key to see the agent loop, token injection, and the
approval gate.)

## Make it real

- Swap the strategy in the demo for `OAuth2(...)` or `Auth0(...)` to issue real GitHub tokens.
- This same `nomineeTool(...)` works inside **Cloudflare Agents**, which use the AI SDK under the hood.
