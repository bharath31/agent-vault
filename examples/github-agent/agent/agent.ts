import { defineAgent } from 'eve'

// Tools are auto-discovered from agent/tools/*.ts.
// Model calls route through the Vercel AI Gateway (set AI_GATEWAY_API_KEY in
// .env.local, or run `eve link`).
export default defineAgent({
  model: 'anthropic/claude-haiku-4.5',
})
