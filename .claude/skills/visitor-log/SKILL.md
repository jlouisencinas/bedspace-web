---
name: visitor-log
description: bedspace-web Visitor Log module (/visitors, guard role, ID photos, visitor_* RPCs, visitor-ids storage bucket). Load before changing VisitorLog.jsx, Guard* / Visitor* components, src/lib/visitors.js, idPhoto.js, guardShift.js or the visitor_log migration.
---

# Visitor Log (bedspace-web)

Full rules: `docs/requirements.md` §17.

- Page `src/pages/VisitorLog.jsx` (`/visitors`).
- Components: `GuardShell` (guard top bar, menu sheet, red banner, bottom tabs; also exports `BottomSheet`), `GuardShiftPrompt`, `VisitorCheckIn`, `VisitTargetPicker`, `IdPhotoCapture`, `VisitorInsideList`, `VisitorTodayLog`, `VisitorHistory`, `VisitorDetailDrawer`, `VisitorCorrectModal`, `VisitorVoidModal`, `VisitorIdPhoto`.
- Libs: `src/lib/visitors.js` (RPC wrappers, Manila formatters, ID types), `src/lib/idPhoto.js` (compress, upload, signed URL, 90-day purge), `src/lib/guardShift.js` (duty name per sign-in, recent names).
- Schema: `database/migrations/visitor_log.sql` (apply by hand, run its §0 audit first; mirrored in `init.sql` section 8c).
- `visitor_logs` / `visitor_log_edits` have no write grants or policies: every write goes through the `visitor_*` SECURITY DEFINER RPCs (a trigger rejects anything else and every DELETE; void/correct only).
- The private `visitor-ids` storage bucket is upload-only for guard/admin/user and read/delete for admin only. Photos are removed only through the Storage API by the admin purge, never by SQL.
- Guard role details: see the `roles-and-rls` skill.
