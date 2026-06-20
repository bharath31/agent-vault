import { defineAgent } from 'eve'

// The Eve agent entrypoint. Tools are auto-discovered from agent/tools/*.ts —
// star_repo.ts is wrapped with nominee for a fresh token + human approval.
export default defineAgent({
  model: 'openai/gpt-5.4-mini',
})
