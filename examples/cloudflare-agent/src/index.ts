import { generateText, stepCountIs } from 'ai'
import { Nominee } from 'nominee'
import { nomineeTool } from 'nominee-ai'
import { createWorkersAI } from 'workers-ai-provider'
import { z } from 'zod'

interface Env {
  AI: Ai
}

// A Cloudflare Worker agent: a Workers AI model drives a tool call, and nominee
// injects a fresh token + gates the action behind approval. No API key — it uses
// Cloudflare's models. This is the same AI SDK stack the Cloudflare Agents SDK
// builds on, so `nomineeTool` drops into a full `agents` app unchanged.
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const task = url.searchParams.get('task') ?? 'Close stale issue 1242 in acme/api.'

    const workersai = createWorkersAI({ binding: env.AI })
    const model = workersai('@cf/meta/llama-3.3-70b-instruct-fp8-fast')

    const audit: unknown[] = []
    const nominee = new Nominee({
      // demo strategy — swap for Auth0() / OAuth2() in production
      strategy: ({ connection }) => `mock-${connection}-token-${Date.now().toString(36)}`,
      // auto-approve so this stateless demo completes in one request; in a real
      // app this is where you'd push to the user's device (e.g. Auth0 CIBA)
      onApprovalRequest: (req) => nominee.resolveApproval(req.id, 'approved'),
      onAudit: (e) => audit.push(e),
      agent: 'cf-triage-agent',
    })

    const closeIssue = nomineeTool({
      nominee,
      user: 'alice',
      connection: 'github',
      approval: true,
      action: 'github.close_issue',
      description: 'Close a GitHub issue in a repository',
      inputSchema: z.object({ repo: z.string(), issue: z.number() }),
      async execute({ repo, issue }, { token }) {
        // a real impl would call the GitHub API with the fresh `token`
        return { ok: true, repo, issue, tokenPreview: `${token?.slice(0, 14)}…` }
      },
    })

    try {
      const result = await generateText({
        model,
        tools: { closeIssue },
        stopWhen: stepCountIs(5),
        prompt: task,
      })
      return Response.json(
        {
          task,
          text: result.text,
          toolCalls: result.steps.flatMap((s) => s.toolCalls),
          toolResults: result.steps.flatMap((s) => s.toolResults),
          audit,
        },
        { headers: { 'access-control-allow-origin': '*' } },
      )
    } catch (err) {
      return Response.json({ error: String(err), audit }, { status: 500 })
    }
  },
}
