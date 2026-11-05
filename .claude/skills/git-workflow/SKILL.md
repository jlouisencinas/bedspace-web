---
name: git-workflow
description: bedspace-web branch, commit and pull-request rules, including the PR sync loop (overlap check, merge main before opening, re-sync open PRs after merges, stacked PRs, conflict hotspots). Every change goes on its own feat/ or fix/ branch and ends in a PR that the user merges. Load at the start and end of every dev-pipeline run, whenever committing, pushing or opening a PR, and whenever the user says a PR was merged.
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

**Overlap check (before planning):** list the open PRs and the files they touch:
```
gh pr list --state open --json number,headRefName,title
gh pr diff <n> --name-only        # for each open PR
```
If this task will touch the same files as an open PR, say so in one line to the user and in `requirement.md`, and prefer
waiting for that PR to merge. Build on top of it only if the user wants to (stack, §6).

## 2. Commit (after QA and the tester pass)
- Stage only the files of this task (`git add <paths>`); never `git add -A` blindly. Never commit `.env*`, `.pipeline/`,
  `.email-preview/`, `dist/`.
- One commit per task is fine; a revision round may add commits. Message style matches history:
  `fix: <what is now true>` / `feat: <capability>` + a short body (why, migration note if any), ending with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## 3. Sync with main, then push and open the PR
Before every push that opens or updates a PR, bring the branch up to date with `main` (merge, never rebase: rewriting a
pushed branch needs a force push, which the guard-git hook blocks):
```
git fetch origin
git merge origin/main             # on the task branch; base branch for a stacked PR (§6)
```
- Conflicts: resolve them on the branch. Docs/backlog lists (`docs/requirements.md`, esp. §15): keep both sides' items.
  Code: keep both intents; if that needs a judgement about money, roles or tenant-facing behaviour, stop and ask the user.
  Never resolve by dropping the other side's change.
- After the merge (conflicts or not), run `npm test && npm run build` again. A failure here goes back through the fix
  loop (dev-pipeline §3), not into the PR.
- Commit the merge as `Merge main into <branch>` (+ one line on what was resolved) with the Co-Authored-By line.

Then:
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
- QA: PASS (round N)  - Tester: PASS / skipped (tier S) - `npm test`: <N passed> - `npm run build`: clean
- Synced with main at <short sha> (conflicts: none | <files, how resolved>)
<key test cases>

## Docs
<requirements.md sections updated>

## Merge notes
<anything the user must do before/after merging, or "None">

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

## 4. After opening
Report the PR link. Do not merge, do not enable auto-merge. Switch back with `git switch main` only if the user asks.
Right after opening, check `gh pr view <n> --json mergeable,mergeStateStatus`: `CONFLICTING` means `main` moved in the
meantime; run §3's sync again.

## 5. Re-sync open PRs after anything merges
Whenever the user says a PR was merged, or a session starts with open PRs from this pipeline:
```
git fetch origin
gh pr list --state open --json number,headRefName,mergeable,mergeStateStatus,baseRefName
```
For each open pipeline PR that is `CONFLICTING` / `DIRTY` or `BEHIND`: first check `git status`; if the working tree has
uncommitted changes, stop and tell the user (don't stash or commit another task's work to make room). Otherwise switch
to the PR's branch, run §3's sync, test, build, push. Report one line per PR
(synced / conflicts resolved in <files> / needs the user). Never merge a PR yourself; mergeability is all you fix.
(`UNKNOWN` right after a push is GitHub still computing: check again once before acting.)

## 6. Stacked PRs (only when the user wants to build on an unmerged PR)
- Branch from the lower PR's branch and open the upper PR with `--base <lower branch>` and `--draft`, title prefixed
  `[stacked on #<n>]`, and a first Merge-notes line: "Merge #<n> first; then this retargets to main."
- Tell the user the merge order: **bottom up**. Merging the upper PR first lands it in the lower branch, not `main`, and
  the lower PR silently grows (that happened with #5 → #3).
- When the lower PR merges: `gh pr edit <upper> --base main`, run §3's sync against `origin/main`, test, build, push,
  then `gh pr ready <upper>`.
- If the upper PR was merged into the lower branch anyway: update the lower PR's body to say it now contains both, and
  sync it with `main` (§3).

## 7. Conflict hotspots (keep them small)
- `docs/requirements.md` §15 (Known follow-ups) and similar running lists: add new items with a date prefix
  (`- [ ] (2026-11-05) …`) in date order, not glued to the last line someone else also appends to; edit only your own items.
- `CLAUDE.md` Map: add entries in alphabetical/natural position within the line, not always at its end.
- Shared money modules (`src/lib/billing.js`, `finalBill.js`, `cutoffBilling.js`) and `src/App.jsx` routes: if two open PRs
  touch them, they merge one at a time with a re-sync (§5) in between; mention it in Merge notes.
