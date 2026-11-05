// PreToolUse guard for git in Bash/PowerShell: every change goes on its own branch and reaches main
// only through a pull request the user merges. Blocks commits on main/master, pushes to main/master,
// and plain force pushes (--force-with-lease on a feature branch is allowed).
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `[guard-git] ${reason} Follow the git-workflow skill: create a feat/ or fix/ branch, commit there, push it and open a PR; the user merges.`,
    },
  }))
  process.exit(0)
}

let input
try { input = JSON.parse(readFileSync(0, 'utf8') || '{}') } catch { process.exit(0) }
const cmd = String(input.tool_input?.command || '')
if (!/\bgit\b/.test(cmd)) process.exit(0)

function branch() {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: input.cwd || process.cwd(), encoding: 'utf8' }).trim()
  } catch { return '' }
}

// Each git invocation in a compound command, up to the next ; && || | or newline.
const parts = cmd.match(/\bgit\b[^;&|\n]*/g) || []
for (const p of parts) {
  const sub = p.replace(/\s+-C\s+\S+/g, ' ').replace(/\s+-c\s+\S+/g, ' ')
  if (/^git\s+commit\b/.test(sub)) {
    const b = branch()
    if (b === 'main' || b === 'master') deny(`Committing directly on ${b} is not allowed.`)
  }
  if (/^git\s+push\b/.test(sub)) {
    if (/(\s|:)(main|master)\b/.test(sub)) deny('Pushing to main/master is not allowed.')
    if (/\s(--force(?!-with-lease)\b|-f\b)/.test(sub)) deny('Plain force push is not allowed (use --force-with-lease on your own feature branch).')
    const b = branch()
    const positional = sub.replace(/^git\s+push/, '').trim().split(/\s+/).filter(t => t && !t.startsWith('-'))
    const onMain = b === 'main' || b === 'master'
    if (onMain && (positional.length < 2 || positional.slice(1).some(r => /^(\+)?HEAD(:|$)/.test(r)))) deny(`This push while on ${b} would push ${b}.`)
  }
}
process.exit(0)
