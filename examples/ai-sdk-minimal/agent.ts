import { createOpenAI } from '@ai-sdk/openai'
import { stepCountIs, streamText } from 'ai'
import { Nominee } from 'nominee'
import { nomineeTool } from 'nominee-ai'
import { z } from 'zod'

// 1. One nominee instance. The strategy is just a function — no provider, no
//    signup. It resolves a FRESH token at the moment of every tool call.
const nominee = new Nominee({
  strategy: ({ connection }) => process.env[`${connection.toUpperCase()}_TOKEN`]!,
  // No SaaS for approvals either: decide here (Slack, a web button, the terminal…).
  onApprovalRequest: (req) => {
    console.log(`\n🔐 approve "${req.action}"? auto-approving in 1s for the demo…`)
    setTimeout(() => nominee.resolveApproval(req.id, 'approved'), 1000)
  },
  onAudit: (e) => console.log('[audit]', e.type, e.action ?? e.connection ?? ''),
})

// 2. Wrap any AI SDK tool: fresh token + human approval + audit, one wrapper.
const starRepo = nomineeTool({
  nominee,
  user: 'demo-user',
  connection: 'github',
  approval: true,
  action: 'star_repo',
  description: 'Star a GitHub repository on behalf of the user',
  inputSchema: z.object({ owner: z.string(), repo: z.string() }),
  async execute({ owner, repo }, { token }) {
    const res = await fetch(`https://api.github.com/user/starred/${owner}/${repo}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
    })
    return res.ok ? `starred ${owner}/${repo}` : `failed: ${res.status}`
  },
})

// 3. Point the AI SDK at any model. OpenRouter gotcha: use .chat(), not the default.
const openrouter = createOpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: process.env.OPENROUTER_API_KEY,
})

const result = streamText({
  model: openrouter.chat('openai/gpt-4o-mini'),
  tools: { star_repo: starRepo },
  stopWhen: stepCountIs(5),
  prompt: 'Star the repo bharath31/nominee for me.',
})

for await (const chunk of result.textStream) process.stdout.write(chunk)
console.log()
