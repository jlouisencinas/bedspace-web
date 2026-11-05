---
name: dev-pipeline
description: The default way to handle ANY feature, change or bug-fix request for bedspace-web, whether or not the user names the pipeline. Sizes the task (tier S/M/L), creates a branch, routes it through solution-architect -> fullstack-engineer -> qa-engineer -> (database-admin) -> tester with fix loops, updates docs/requirements.md, commits, pushes and opens a PR. Fully autonomous. Not for plain questions or small direct actions.
---

# Dev pipeline (orchestrator playbook)

You, the main session, are the orchestrator: a hub that routes work. Agents never talk to each other. Keep your own
context small: agents write their full output to files, you read only their short reply and the files you need.

Run fully autonomously. Stop and ask the user only when: the architect lists a blocking open question about money,
data loss or tenant-facing behaviour; the tester is BLOCKED on a sign-in; a guard hook refuses something the task truly
needs; or the revision cap is reached.

## 0. Triage (one line to the user: "Tier M: <why>")
| Tier | When | Steps |
|---|---|---|
| **S** | 1-3 files, no money logic, no RLS/roles, no schema, low risk (copy, layout, small UI fix, clear error message) | engineer → QA (`model: sonnet`) → commit/PR. Tester only if the change is visible in the UI. No architect: you write a 5-line plan yourself. The engineer adds a test when the change touches `src/lib/`; pure UI/copy changes need none. |
| **M** | A normal feature or fix with UI | architect (short plan) → engineer → QA → tester (affected screens only) → PR |
| **L** | Touches money/billing, RLS/roles, schema/migrations, notifications, or more than ~8 files | architect (full plan) → engineer → QA → database-admin applies migration → tester (full) → PR |

Anything touching money, RLS or schema is L however small. Optional switches the user may put anywhere in the request:
`tier:S|M|L` (force a tier), `plan-only` (stop after the plan), `no-browser` (skip the tester), `no-pr` (stop before
commit). Without switches, decide yourself.

## 1. Set up
1. Task id: `<yyyymmdd>-<short-kebab>`. Create `.pipeline/<task>/` and write `requirement.md` (the user's words verbatim +
   tier + switches) and `status.md` (one line per step as it completes, so a new session can resume).
2. Branch: follow the `git-workflow` skill §1 before any file edit, including its overlap check against open PRs.
3. Load the knowledge skills that match the area (`billing-rules`, `roles-and-rls`, `db-migrations`, `notifications`,
   `visitor-log`, `occupancy-dashboard`) and name them in every agent prompt so the agent loads them too.

## 2. Agent calls
Every prompt is self-contained and short: the task folder path, which files to read in it, the skills to load, and
"write your full output to `.pipeline/<task>/<file>`; reply to me with at most 12 lines: VERDICT/status, blocking items,
file path." Never paste whole plans or diffs into prompts; pass paths. Wait for each agent (each step needs the previous one).

| Step | Agent | Reads | Writes |
|---|---|---|---|
| Plan | `solution-architect` | requirement.md | plan.md |
| Build | `fullstack-engineer` | plan.md | code + tests + impl.md (+ migration file, + requirements.md edits) |
| Review | `qa-engineer` | plan.md, `git diff origin/main...HEAD` + working tree (not impl.md first); runs `npm test` + `npm run build` | qa-<n>.md |
| Migrate (L, if a migration exists) | `database-admin` | plan.md, the migration file | db.md |
| Test | `tester` | plan.md acceptance criteria, impl.md "How to verify" | test-<n>.md |

Models are set in each agent file (architect/engineer/QA/database-admin: opus; tester: sonnet). Override with the Agent
tool's `model` only for tier S QA (`sonnet`).

## 3. Fix loop (cap: 3 revision rounds)
- QA FAIL or tester FAIL → send the blocking items **to the same engineer** with `SendMessage` (keeps its context; do not
  start a new engineer), then QA again, then tester again.
- Tester BLOCKED (`NEEDS SIGN-IN: <role>`) → ask the user to sign in as that role in the Browser pane; not a revision round.
- After 3 rounds without both passing: stop, report what was tried, what still fails, your recommendation. Leave the
  branch pushed and open the PR as a **draft** (`gh pr create --draft`) so the work isn't lost.

## 4. Database (tier L)
The only database is production. After QA passes and before the tester runs, the `database-admin` applies the reviewed
migration following the `db-migrations` procedure (inspect → back up → apply → verify → log in `applied.md`). The
migration must be additive (old frontend keeps working) unless plan.md declares a `guard-db:allow` operation the
requirement needs (`db-migrations` skill). If it's refused by the guard-db hook, stop and tell the user.

## 5. Docs (every tier)
The plan names the `docs/requirements.md` sections to update; the engineer edits only those sections (and the CLAUDE.md
Map if files/pages were added); QA checks the docs match the code. Mark a backlog item done in §15 when it is.

## 6. Finish
1. Before the commit, run `npm test && npm run build` once more yourself. Commit, then **sync with `main`** (`git-workflow`
   §3: merge `origin/main`, resolve conflicts, re-run `npm test && npm run build`), then push and open the PR. Write
   `.pipeline/<task>/pr.md` first; it is the PR body and includes the `npm test` summary line and the sync line. CI
   (`.github/workflows/ci.yml`) runs the same two commands on the PR. After opening, check mergeability (`git-workflow` §4).
   Stacked on an unmerged PR? Follow `git-workflow` §6 (draft, bottom-up merge order).
2. Report to the user (short): tier, what changed (user-visible), files, QA/tester results, database changes (applied to
   production yes/no), requirements.md sections updated, PR link, anything they must do before merging. Merging is
   theirs.

## Notes
- `.pipeline/` is git-ignored and is the memory of a task: to resume in a new session, read `status.md` and continue.
- Production investigation (a user reports an error): `database-admin` in read-only mode first (logs via `query_logs`,
  data, policies), then a fix pipeline with the root cause in requirement.md.
- Never commit or push to `main`; the user merges every PR. When the user says a PR was merged, re-sync the other open
  pipeline PRs (`git-workflow` §5) before starting new work.
- Never run tests against production. Tests are fixture-only by design (`src/test/setup.js` blocks `src/lib/supabase.js` and
  the network).
