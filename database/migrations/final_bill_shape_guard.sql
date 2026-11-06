-- Final-bill shape guard (G4). Idempotent, hand-applied (do NOT run all of init.sql). Mirrored in database/init.sql right after G2.
-- Requirements §5 "Final bill guards". Task 20261106-final-bill-stale-client.
--
-- Why: a browser tab still running an app build from before 2026-11-03 issued final bill #26 with superseded logic (no cutoff,
-- no covered periods, no advance check, no vacated tick, so no move-out readings were saved). G4 refuses a NEW FINAL bill with
-- that shape, whatever client sends it. The client mirror is finalBillShapeProblem() in src/lib/finalBill.js.
--   - cutoff_id may be null only when no cutoff's water window gives the move-out date a cutoff (mirror of
--     finalCutoffForUtility(cutoffs, 'WATER', date) in src/lib/stay.js: a window holding the date, or the date on/after the end
--     of the latest window). A date in a gap between water windows, or before every window, keeps cutoff_id null.
--   - covered_cutoffs is NOT checked: a stay that began after the latest window legitimately stores [] with a cutoff_id.
--   - details.advance_check must be an object; details.vacated too, except on a re-issue (replaces_bill_id set by the
--     reissue_final_bill RPC, which may replace an old bill that never had it).
-- BEFORE INSERT only: existing rows (bills 7 and 26 are the known pre-guard exceptions) and every UPDATE (void, refund,
-- correct_receipt_ref, a data repair) are untouched. SECURITY DEFINER like G1-G3 (it reads public.cutoffs). No RLS change.
--
-- ===== AUDIT: read-only, informational. Every row except #7 and #26 has ac = vc = 'object' and a cutoff_id. =====
--    select id, status, cutoff_id, covered_cutoffs, move_out_date, replaces_bill_id,
--           jsonb_typeof(details->'advance_check') ac, jsonb_typeof(details->'vacated') vc, created_at
--      from final_bills order by id desc limit 30;

create or replace function public.final_bills_shape_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status is distinct from 'FINAL' then return new; end if;
  if new.cutoff_id is null and (
       exists (select 1 from public.cutoffs c
                where c.water_start is not null and c.water_end is not null
                  and c.water_start <= new.move_out_date and new.move_out_date < c.water_end)
       or (not exists (select 1 from public.cutoffs c where c.water_start > new.move_out_date)
           and new.move_out_date >= (select c.water_end from public.cutoffs c where c.water_start is not null
                                      order by c.water_start desc, c.id desc limit 1))) then
    raise exception 'final bill: no cutoff is set on this bill. The app in this browser is out of date: reload the page and issue the bill again. Nothing was changed.';
  end if;
  if jsonb_typeof(new.details->'advance_check') is distinct from 'object' then
    raise exception 'final bill: the advance check is missing. The app in this browser is out of date: reload the page and issue the bill again. Nothing was changed.';
  end if;
  if new.replaces_bill_id is null and jsonb_typeof(new.details->'vacated') is distinct from 'object' then
    raise exception 'final bill: the vacated confirmation is missing. The app in this browser is out of date: reload the page and issue the bill again. Nothing was changed.';
  end if;
  return new;
end $$;
drop trigger if exists trg_final_bills_shape_guard on public.final_bills;
create trigger trg_final_bills_shape_guard before insert on public.final_bills
  for each row execute function public.final_bills_shape_guard();
