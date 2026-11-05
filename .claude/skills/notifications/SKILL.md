---
name: notifications
description: bedspace-web email notifications - notify-email Edge Function, notification type registry, approval/ticket email builders, Apps Script mailer, secrets and deploy rules. Load before touching supabase/functions/, src/lib/notify.js, apps-script/, or adding a notification type.
---

# Notifications (bedspace-web)

Email on new approval requests, approval decisions (approved/rejected) and maintenance tickets. The client calls `notifyAsync(type, recordId)` (`src/lib/notify.js`); the `notify-email` Edge Function loads the row and emails subscribed recipients via the Apps Script mailer.

- Files: `supabase/functions/notify-email/` + `supabase/functions/_shared/notification-types.ts` (type registry). Deployed via the Supabase MCP/CLI, **not** by Vercel.
- `apps-script/bedspace-mailer.gs` is a reference copy. The live copy is in Google Apps Script under bedspacemkt@gmail.com; a change there needs a "New version" web-app deployment.
- `approval_decision` is fired from `Approvals.jsx` `decide()` after the whole path succeeded (never from `approvals.js`). It also emails the requester (single recipient) using the address from the auth admin API, never `approval_requests.requester_email`; subscribed admins get the admin copy. Its `load()` requires: admin caller, status `APPROVED`/`REJECTED`, `decision_maker_id` = caller, fresh `decided_at` (10 min). Request-type handlers require `PENDING` + fresh instead.
- Approval and ticket emails are built by pure modules (`email-kit.ts`, `approval-email.ts`, `ticket-email.ts`, `approval-fixtures.ts`, `_shared/approval-labels.ts`; no Deno globals, no imports of `events.ts`/`email.ts`/`index.ts`). Approval emails mask PII. Spacing is `<td>` padding on a 4/6/8/10/12/16/20/24/32 scale via `stack()`; no margins except `margin:0` (h1) and `margin:0 auto` (centering the button table).
- **Never write `\u` escapes under `supabase/functions/`** (the deploy transport decodes them; use `String.fromCharCode`). The preview script scans for this.
- The plain test email is built inline in `index.ts`. After changing emails run `node scripts/preview-approval-email.mjs` (sends nothing; writes git-ignored `.email-preview/`). Admins can send fictitious samples per recipient from the settings page.
- **Add a type:** entry in `NOTIFICATION_TYPES` (`_shared/notification-types.ts`), handler in `notify-email/events.ts`, call `notifyAsync` after the triggering insert, redeploy. No SQL, no settings-page change. The handler's `load()` must authorize the caller, require the right state (`PENDING` for "raised" events; `APPROVED`/`REJECTED` by the caller for the decision event) and freshness. Existing recipients are NOT subscribed to a new type until an admin ticks it.
- Secrets (`APPS_SCRIPT_URL`, `APPS_SCRIPT_SECRET`, `APP_URL`) live only in Supabase; `MAILER_SECRET` only in the Apps Script's Script Properties. Never put any of them in the repo.
- Deploy with JWT verification on (`verify_jwt=true`; no `config.toml` in the repo, so it is a deploy-time setting; never `--no-verify-jwt`; the guard-db hook blocks `verify_jwt:false`). Always build messages from the DB row by id, never from caller-supplied text.
