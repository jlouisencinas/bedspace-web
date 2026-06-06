-- Allow manually-entered / edited monthly snapshots (backfill prior months).
-- Run in Supabase SQL Editor.
alter table monthly_reports add column if not exists manual boolean default false;
-- cutoff_id is already nullable; manual rows simply have no cutoff_id.
