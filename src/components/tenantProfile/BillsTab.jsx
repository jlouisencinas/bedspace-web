import { Link } from 'react-router-dom'
import { CreditCard } from 'lucide-react'
import { dbToCents } from '../../lib/receiptLines'
import { groupPaymentsByCutoff, centsToPeso } from '../../lib/tenantHistory'
import { reissueBlocker } from '../../lib/finalBill'
import StatementHistory from './StatementHistory'

const CATEGORY_LABEL = { RENT_WATER: 'Rent & Water', ELECTRICITY: 'Electricity', OTHER: 'Other' }
const DEPOSIT_STATUSES = ['HELD', 'APPLIED', 'FORFEITED', 'REFUNDED']

function fmtDate(d) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' })
}

function SectionTitle({ children }) {
  return <div className="text-[10px] font-bold text-ink-faint uppercase tracking-widest mb-2">{children}</div>
}

function ErrorBox({ children }) {
  return (
    <div className="text-[12px] text-danger-text bg-danger-bg border border-danger-border rounded-lg px-3 py-2.5 mb-3">{children}</div>
  )
}

export default function BillsTab({
  tenant, siblingIds, transfers, transfersError,
  payments, paysError, cutoffs, cutoffsError,
  bills, billsLoading, billsError,
  deposits, depLoadError,
  canPrint, isAdmin, voidId, voidReason, billBusy,
  onStartVoid, onVoidReason, onConfirmVoid, onCancelVoid, onReissue, onGoToAdvance,
}) {
  const { groups, totalCents } = groupPaymentsByCutoff(payments, cutoffs)
  const voidedIds = new Set((payments || []).filter(p => p.voids_payment_id).map(p => p.voids_payment_id))

  const depSummary = DEPOSIT_STATUSES.map(status => {
    const rows = (deposits || []).filter(d => d.status === status)
    return { status, count: rows.length, cents: rows.reduce((s, d) => s + dbToCents(d.amount), 0) }
  }).filter(s => s.count > 0)

  return (
    <div className="space-y-5">
      {/* ── Final bills ── */}
      <div>
        <SectionTitle>Final bills</SectionTitle>
        {billsLoading ? (
          <p className="text-[12px] text-ink-muted">Loading final bills…</p>
        ) : billsError ? (
          <ErrorBox>Could not load final bills: {billsError}</ErrorBox>
        ) : bills.length === 0 ? (
          <p className="text-[13px] text-ink-faint italic">No final bill on record.</p>
        ) : (
          <div className="space-y-2">
            {bills.map(b => {
              const net = Number(b.net_amount)
              return (
                <div key={b.id} className="p-3 rounded-xl bg-surface-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[13px] font-semibold text-ink">Final bill #{b.id}</span>
                    <span className="text-[12px] text-ink-muted">{fmtDate(b.move_out_date)}</span>
                    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${b.status === 'VOID' ? 'bg-danger-bg text-danger-text' : 'bg-success-bg text-success-text'}`}>{b.status}</span>
                    <span className={`text-[13px] font-semibold ml-auto ${net < 0 ? 'text-success-text' : 'text-ink'}`}>
                      {net < 0 ? `Refund ${centsToPeso(-dbToCents(b.net_amount))}` : `Due ${centsToPeso(dbToCents(b.net_amount))}`}
                    </span>
                  </div>
                  {b.early_termination && (
                    <div className="text-[11px] text-ink-muted mt-0.5">
                      Early termination — {b.forfeit_waived ? `forfeiture waived: ${b.waived_reason}` : 'advance and deposit forfeited'}
                    </div>
                  )}
                  {b.details?.advance_check?.text && <div className="text-[11px] text-ink-muted mt-0.5">{b.details.advance_check.text}</div>}
                  {b.status === 'VOID' && <div className="text-[11px] text-danger-text mt-0.5">Voided: {b.void_reason}{b.replaced_by_bill_id != null ? ` · Replaced by #${b.replaced_by_bill_id}` : ''}</div>}
                  {b.replaces_bill_id != null && <div className="text-[11px] text-ink-muted mt-0.5">Replaces #{b.replaces_bill_id} (voided)</div>}
                  {(canPrint || isAdmin) && (
                    <div className="flex items-center gap-2 mt-2">
                      {canPrint && <Link className="btn-xs blue" to={`/print/final-bill?id=${b.id}`}>Print</Link>}
                      {isAdmin && b.status === 'FINAL' && voidId !== b.id && (
                        <button className="btn-xs red" onClick={() => onStartVoid(b.id)}>Void</button>
                      )}
                      {isAdmin && b.status === 'FINAL' && voidId !== b.id && onReissue && (() => {
                        const why = reissueBlocker({ bill: b, tenant, isAdmin })
                        return (
                          <>
                            <button className="btn-xs" disabled={!!why} title={why || 'Void this bill and issue a corrected one in its place, in one step'} onClick={() => onReissue(b)}>Void &amp; re-issue</button>
                            {why && <span className="text-[11px] text-ink-muted">{why}</span>}
                          </>
                        )
                      })()}
                    </div>
                  )}
                  {isAdmin && voidId === b.id && (
                    <div className="flex items-center gap-2 mt-2">
                      <input type="text" className="flex-1" placeholder="Reason for voiding (required)" value={voidReason}
                        onChange={e => onVoidReason(e.target.value)} />
                      <button className="btn-xs red" disabled={billBusy || !voidReason.trim()} onClick={onConfirmVoid}>{billBusy ? 'Voiding…' : 'Confirm void'}</button>
                      <button className="btn-xs" disabled={billBusy} onClick={onCancelVoid}>Cancel</button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* ── Monthly statements ── */}
      <div>
        <SectionTitle>Monthly statements</SectionTitle>
        <StatementHistory key={tenant.id}
          tenant={tenant} siblingIds={siblingIds} cutoffs={cutoffs} cutoffsError={cutoffsError}
          payments={payments} paysError={paysError} finalBills={bills} billsLoading={billsLoading} billsError={billsError}
          transfers={transfers} transfersError={transfersError} isAdmin={isAdmin} canAct={canPrint} />
      </div>

      {/* ── Payments by cutoff ── */}
      <div>
        <SectionTitle>Payments by cutoff</SectionTitle>
        {paysError ? (
          <ErrorBox>Could not load payments: {paysError}</ErrorBox>
        ) : payments.length === 0 ? (
          <div className="text-center py-4">
            <CreditCard size={24} className="mx-auto mb-2 text-ink-faint" />
            <p className="text-[13px] text-ink-faint">No payments recorded.</p>
          </div>
        ) : (
          <>
            {cutoffsError && (
              <ErrorBox>Could not load cutoff names ({cutoffsError}); payments are grouped by cutoff number.</ErrorBox>
            )}
            <div className="space-y-3">
              {groups.map(g => (
                <div key={g.cutoffId ?? 'none'} className="rounded-xl border border-line overflow-hidden">
                  <div className="flex items-center justify-between px-3 py-1.5 bg-surface-2 text-[12px]">
                    <span className="font-semibold text-ink">{g.name}</span>
                    <span className="font-semibold text-ink">{centsToPeso(g.totalCents)}</span>
                  </div>
                  <table className="payments-table">
                    <thead><tr><th>Date</th><th>Category</th><th>Type</th><th>Amount</th><th>Notes</th></tr></thead>
                    <tbody>
                      {g.rows.map(p => (
                        <tr key={p.id}>
                          <td>{fmtDate(p.payment_date)}</td>
                          <td>{CATEGORY_LABEL[p.category] || p.category || '—'}</td>
                          <td>
                            {p.pay_type || '—'}
                            {p.voids_payment_id && (
                              <span className="ml-1 text-[10px] font-bold px-1.5 py-0.5 rounded bg-danger-bg text-danger-text">Void of #{p.voids_payment_id}</span>
                            )}
                            {voidedIds.has(p.id) && (
                              <span className="ml-1 text-[10px] font-bold px-1.5 py-0.5 rounded bg-surface-3 text-ink-muted">Voided</span>
                            )}
                          </td>
                          <td className={dbToCents(p.amount) < 0 ? 'text-danger-text' : ''}>{centsToPeso(dbToCents(p.amount))}</td>
                          <td className="text-ink-muted">{p.notes || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
            <div className="flex items-center justify-between mt-3 px-3 py-2 rounded-xl bg-surface-2 text-[13px]">
              <span className="font-semibold text-ink">Total paid ({payments.length} {payments.length === 1 ? 'row' : 'rows'}, voids netted)</span>
              <span className="font-semibold text-ink">{centsToPeso(totalCents)}</span>
            </div>
          </>
        )}
      </div>

      {/* ── Advance / deposit receipts ── */}
      <div>
        <SectionTitle>Advance &amp; deposit receipts</SectionTitle>
        {depLoadError ? (
          <ErrorBox>Could not load advance/deposit records: {depLoadError}</ErrorBox>
        ) : depSummary.length === 0 ? (
          <p className="text-[13px] text-ink-faint italic">No advance or deposit receipts recorded.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {depSummary.map(s => (
              <div key={s.status} className="rounded-xl bg-surface-2 px-3 py-2">
                <div className="text-[10px] font-bold text-ink-faint uppercase tracking-widest">{s.status}</div>
                <div className="text-[13px] font-semibold text-ink mt-0.5">{centsToPeso(s.cents)}</div>
                <div className="text-[10px] text-ink-faint">{s.count} {s.count === 1 ? 'receipt' : 'receipts'}</div>
              </div>
            ))}
          </div>
        )}
        <button className="btn-xs mt-2" onClick={onGoToAdvance}>
          Open Advance &amp; Deposit
        </button>
      </div>
    </div>
  )
}
