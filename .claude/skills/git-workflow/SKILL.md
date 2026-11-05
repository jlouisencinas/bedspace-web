---
name: git-workflow
description: bedspace-web branch, commit and pull-request rules. Every change goes on its own feat/ or fix/ branch and ends in a PR that the user merges. Load at the start and end of every dev-pipeline run, or whenever committing, pushing or opening a PR.
---

# Branch → commit → PR (bedspace-web)

Repo: `jlouisencinas/bedspace-web` (GitHub). Merging to `main` deploys production on Vercel, so **only the user merges**.
The guard-git hook blocks commits on `main`, pushes to `main`, and plain force pushes.

## 1. Start (before the first file edit)
```
git fetch origin
git switch -c <type>/<short-kebab-name> origin/main
```
`<type>` is `feat` (new behaviour), `fix` (bug), `chore` (docs/tooling only). Name it after the outcome, e.g.
`fix/receipt-edit-role-error`. If the working tree already has uncommitted changes that belong to this task, they come
along on `switch -c`; if they belong to something else, stop and tell the user instead of mixing them in.

## 2. Commit (after QA and the tester pass)
- Stage only the files of this task (`git add <paths>`); never `git add -A` blindly. Never commit `.env*`, `.pipeline/`,
  `.email-preview/`, `dist/`.
- One commit per task is fine; a revision round may add commits. Message style matches history:
  `fix: <what is now true>` / `feat: <capability>` + a short body (why, migration note if any), ending with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## 3. Push and open the PR
```
git push -u origin <branch>
gh pr create --base main --head <branch> --title "<type>: <summary>" --body-file .pipeline/<task>/pr.md
```
If `gh` is missing (not installed or not signed in), push anyway and give the user this link to open the PR in one click:
`https://github.com/jlouisencinas/bedspace-web/compare/main...<branch>?expand=1`, with the PR text from `.pipeline/<task>/pr.md`.

PR body (`pr.md`):
```
## What changed
<user-visible outcome, 1-3 bullets>

## Why
<the request / bug, root cause for fixes>

## Database
<"None" | migration file, applied to production on <date> (yes/no), backup table, verify result>

## How it was verified
- QA: PASS (round N)  - Tester: PASS / skipped (tier S) - `npm run build`: clean
<key test cases>

## Docs
<requirements.md sections updated>

## Merge notes
<anything the user must do before/after merging, or "None">

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

## 4. After opening
Report the PR link. Do not merge, do not enable auto-merge. Switch back with `git switch main` only if the user asks.
