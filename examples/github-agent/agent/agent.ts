import { defineAgent } from 'eve'

// Tools are auto-discovered from agent/tools/*.ts.
export default defineAgent({
  model: 'anthropic/claude-sonnet-4.6',
})
