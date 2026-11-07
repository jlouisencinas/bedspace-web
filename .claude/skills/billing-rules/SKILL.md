---
name: billing-rules
description: bedspace-web money rules and code map for billing, rent, utilities allocation, payments, advance/deposit receipts (S.I#/T.R#), reservation payments, move-out final bills, stays and leases. Load before planning, writing, reviewing or testing anything that touches money, src/lib/billing.js, finalBill.js, stay.js, utilityPieces.js, receiptLines.js, MoveInModal, MoveOutModal, Approvals move-outs, or the print pages.
---

# Billing & money rules (bedspace-web)

Full business rules: `docs/requirements.md` §5 (billing & rent) and §6 (utilities). Read the section you need, not the whole file.

## Hard rules
- Money logic (billing, utilities allocation, rent, late fees) must be exact: integer cents, no silent rounding assumptions, no swallowed errors on financial writes.
- A tenant's outstanding balance always reconciles (sum of bills = sum of payments + adjustments).
- A room's metered consumption always equals the total billed across its tenants for that period, even across move-ins/move-outs/transfers mid-period.
- Never delete billing/payment records: void/adjust only (the guard-db hook blocks it on the live DB unless the task's plan.md declares a `guard-db:allow` delete the requirement needs; see `db-migrations`).

## Code map
- `src/lib/billing.js` (`computeBilling`), `src/lib/pnl.js` (utility P&L), `src/lib/snapshot.js`.
- `src/lib/receiptLines.js` — pure, no imports: strict cents parsing, split receipt line validation, reservation/deposit math.
- `database/migrations/advance_deposit.sql` → `tenant_deposits` (per-tenant advance/deposit receipts with S.I#/T.R#; §5).
- `database/migrations/reservation_payments.sql` → `bed_reservation_payments` (optional money paid on a RESERVED bed, carried into `tenant_deposits` as the deposit at Move In, forfeited by a `beds` trigger on cancel) + `tenant_deposits.payment_mode/bank_ref` + the atomic RPCs `record_move_in_receipts` / `apply_reservation_payments`. Must be applied BEFORE the frontend that uses it (Move In depends on the RPC).
- `tenant_deposits` UPDATE is admin-only under RLS: a staff call returns 0 rows. `updateTenantDeposit` turns that into a clear "only an admin can edit receipts" error; staff move-outs send numbers in the approval request instead.

## Final bill (move-out)
- `src/lib/finalBill.js` — pure move-out Final Bill builder + second-to-last-bill position (`billPosition`; stored `advanceCredits` are legacy Sep 2026 rows only); `final_bills` table (`database/migrations/final_bills.sql`), flow `MoveOutModal` → `processMoveOutWithBill` (`src/lib/supabase.js`), print page `PrintFinalBill` (`/print/final-bill`).
- The advance can never be credited twice: `advanceCheck`/`verifyBillAgainstDb` re-check it from fresh DB data at draft, Confirm and approval apply (stamped in `details.advance_check`), backed by triggers G1-G3 in `database/migrations/advance_credit_guards.sql` (also in `init.sql`). G4 (`final_bill_shape_guard.sql`) refuses a new FINAL bill without a cutoff (when the date has one), `details.advance_check` or `details.vacated` (re-issues exempt from vacated); client mirror `finalBillShapeProblem`. Money writes in `supabase.js` start with `assertAppCurrent()` (stale-tab check).
- Receipt numbers: every receipt the final bill credits/forfeits needs its S.I#/T.R# (`normalizeReceiptRef`/`applyReceiptRefs`/`applyCheckRefs` in `finalBill.js`, inputs in `ReceiptRefInputs`). Admin Confirm writes them to the HELD receipts first; staff send `_bill.receipt_refs`. A settled receipt's number is fixed after move-out only via the admin RPC `correct_receipt_ref` (`database/migrations/final_bill_receipt_refs.sql`, also in `init.sql`; text-only, refuses any amount change).
- `src/lib/stay.js` (stay kind: one-month / whole-months / odd; per-utility cutoff coverage), `src/lib/utilityPieces.js` (stay-anchored utility split, integer-cent allocation, rate fallback), `src/lib/moveOutData.js` (data loader shared by `MoveOutModal` and `Approvals`). `final_bills.covered_cutoffs` comes from `database/migrations/final_bill_covered_cutoffs.sql` (apply before the frontend).
- One-month stays are billed ONLY on the final bill (flat rent; ghost participants in `computeBilling`, shown as "billed on final bill").
- Sibling beds (same name, room, planned date) move out together through one flow and one approval request and print as ONE summed statement (`combineBillsForPrint`, display only; one `final_bills` row per bed stays).
- A move-out after the latest cutoff's window bills against that cutoff, no next cutoff needed (`finalCutoffForUtility`).
- One pending move-out request per tenant. At review and apply the rent/water/electricity lines are recomputed from the DB, edited lines kept (`details.recomputed_at_approval`).
- Admin confirms with the "vacated the room" tick (`details.vacated`). Utility pieces are shared only by active tenants, the leavers and ghosts, never stale inactive rows. Final-bill print numbering is `FINAL-<room>-<series>`.
- Second-to-last bill of a non-month-end leaver (from the Oct 2026 cutoff): the 1-month advance covers the W days of the cutoff (Oct: 31) counted back from the move-out date inclusive (out 11 Nov -> 12 Oct - 11 Nov). The statement bills the FULL month's rent and a line "Less: Advance S.I# <n> | 20 days (Oct 12 to Oct 31)" = min(rent x days-in-cutoff/W, advance on file) (500000 x 20/31 = 3,225.81). The final bill charges the next month's days as rent - credit (1,774.19) against the remaining advance, so the advance nets to exactly one month and is never refunded. Math in `src/lib/advanceWindow.js`; at Open Cutoff the window is frozen in `rent_carryovers` (`database/migrations/rent_carryovers.sql`) and the credit in `advance_credits` (G1-G3). A later contract-date change keeps the frozen credit (warning); an early move-out before the contract date forfeits the advance per the early-termination rule. Snapshot uses raw rent. Falls back to STANDARD for whole-room / transfer / no advance / consumed advance (Sep 2026 credits kept).
- A move-out on the last day of the next window (a calendar month end) has NO second-to-last bill: `billPosition` returns STANDARD, the whole advance goes on the final bill (applies from the Oct 2026 cutoff; stored Sep credits unchanged).
- Stay extension (`src/lib/stayExtension.js`): actual move-out after the contract date -> nights = days after it + 1 if vacated after 12:00 PM, P500/night (constant), line `source: 'EXTENSION'` after rent, `details.extension`; rent stops at the contract date, utilities run to the actual date. Move Out step 1 requires the by/after 12:00 PM choice (`_vacated_after_noon` in a staff request; Approvals asks when missing).
- Void & re-issue a final bill: admin only, `ReissueFinalBillModal` -> RPC `reissue_final_bill` (`database/migrations/final_bill_reissue.sql`, also in `init.sql`): one transaction (old VOID with `voided_by`, receipts HELD, new FINAL inserted under G2, `replaces_bill_id`/`replaced_by_bill_id`, receipts settled, activity). Utilities are recomputed (the approved ones shown for comparison); a hand-typed extension line (`isTypedExtension`) is replaced by the computed one, also in Approvals; single-bed bills only.
- A month-end planned date is never stay-billed. `covered_cutoffs` entries are plain ids or `{id, water, electric}`; payments are netted per component; OTHER or uncategorised payments count on any covered cutoff.
- New tenants' planned move-out is always a month end (Move In picks the lease length; `leaseMoveOut`/`stayRent` in `stay.js`: n whole months flat + excess days / the month's real days; §5).

## Known gaps
`docs/requirements.md` §15 (move-out approval flow, dynamic due-date labels, late-fee toggle, deposit/refund tracking): don't assume current behaviour there is the target.
