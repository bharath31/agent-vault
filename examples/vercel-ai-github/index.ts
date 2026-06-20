import { openai } from '@ai-sdk/openai'
import { generateText } from 'ai'
import { Nominee, tokens } from 'nominee'
import { nomineeTool } from 'nominee-ai'
import { z } from 'zod'
import 'dotenv/config'

async function main() {
  console.log('--- Vercel AI SDK + Nominee Example ---\n')

  if (!process.env.OPENAI_API_KEY) {
    console.warn('⚠️ OPENAI_API_KEY is not set. Please set it to run the LLM generation.')
    console.warn('Example: OPENAI_API_KEY=sk-... pnpm exec tsx index.ts')
    process.exit(1)
  }

  let pendingApprovalId: string | undefined

  // 1. Setup Nominee
  const nominee = new Nominee({
    strategy: tokens(async ({ connection, user }) => {
      // In a real app, fetch from database.
      return {
        token: `mock-${connection}-token-for-${user}`,
        expiresAt: Date.now() + 3600 * 1000,
      }
    }),
    onApprovalRequest: (req) => {
      console.log(`\n[Approval Required] Action: ${req.action}`)
      console.log(`Detail: ${req.detail}`)
      pendingApprovalId = req.id
    },
    onAudit: (e) => {
      console.log(`[Audit] ${e.agent} | Action: ${e.action} | Status: ${e.status || 'success'}`)
    },
    agent: 'github-agent',
  })

  // 2. Define an AI SDK Tool wrapped with Nominee
  const getIssues = nomineeTool({
    nominee,
    // Provide a static user string or a function `(input) => string`
    user: 'alice',
    // Inject a fresh token for 'github' into the execute `ctx`
    connection: 'github',

    description: 'Get recent issues for a GitHub repository',
    parameters: z.object({
      repo: z.string().describe('The repository name, e.g. "vercel/ai"'),
    }),
    execute: async (args, ctx) => {
      // ctx.token is guaranteed fresh and valid
      console.log(`[Tool: getIssues] Fetching issues for ${args.repo} with token ${ctx.token}...`)
      return `Found 3 open issues in ${args.repo}.`
    },
  })

  const starRepo = nomineeTool({
    nominee,
    user: 'alice',
    connection: 'github',
    // This action requires human approval before `execute` is called
    approval: true,
    action: 'github.star',

    description: 'Star a GitHub repository',
    parameters: z.object({
      repo: z.string().describe('The repository name'),
    }),
    execute: async (args, ctx) => {
      console.log(`[Tool: starRepo] Starring ${args.repo} with token ${ctx.token}...`)
      return `Successfully starred ${args.repo}.`
    },
  })

  // 3. We run the generation. We don't await immediately so we can handle the webhook.
  console.log('\n[Agent] Asking LLM to get issues and then star the repo...\n')

  const generatePromise = generateText({
    model: openai('gpt-4o-mini'),
    tools: { getIssues, starRepo },
    maxSteps: 5,
    prompt: 'Get the issues for "auth0/nextjs-auth0", and then star the repository on my behalf.',
  })

  // We simulate the user approving the action in the dashboard 2 seconds from now
  setTimeout(() => {
    if (pendingApprovalId) {
      console.log('\n[Webhook] Simulating user clicking "Approve" in dashboard...')
      nominee.resolveApproval(pendingApprovalId, 'approved')
    }
  }, 2000)

  // 4. Wait for the agent to finish
  const { text } = await generatePromise

  console.log('\n--- Final Agent Response ---')
  console.log(text)
}

main().catch(console.error)
