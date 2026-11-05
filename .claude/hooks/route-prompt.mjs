// UserPromptSubmit: reminds the main session (the orchestrator) to triage every request before acting.
// Kept short on purpose: this text is added to the context on every prompt.
import { readFileSync } from 'node:fs'

let input = {}
try { input = JSON.parse(readFileSync(0, 'utf8') || '{}') } catch {}
const prompt = String(input.prompt || '').trim()
if (prompt.startsWith('/')) process.exit(0) // slash commands and skills route themselves

const context = [
  'ROUTING (bedspace-web): triage this request before any other tool call.',
  '- Question / explanation / advice -> answer directly, no agents.',
  '- Small direct action (commit, push, open PR, look up data, run a command) -> do it directly.',
  '- Production error or "why does X fail" -> investigate first (database-admin, read-only), then run the fix through dev-pipeline.',
  '- Feature, change or bug fix to the app -> invoke the dev-pipeline skill (it picks tier S/M/L and the agents).',
  'Say the route in one short line.',
].join('\n')

process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } }))
