// Synthetic move-out scenarios for buildFinalBillDraft / verifyBillAgainstDb. All on the CUTOFFS fixture (Sep, Oct closed; Nov active).
import { CUTOFFS } from './cutoffs'
import { tenant, deposit, payment } from './tenants'

export const NOW = new Date('2026-11-30T10:00:00+08:00')

// requirements §5 worked example: rate 6,750, Oct 15 -> Nov 30, the Oct statement closed.
export function goldenWholeMonths() {
  const t = tenant({ id: 100, name: 'Tenant Golden', rate: 6750, move_in_date: '2026-10-15', move_out_date: '2026-11-30' })
  return {
    tenant: t, tenants: [t], cutoffs: CUTOFFS, moveOutDate: '2026-11-30', now: NOW,
    readings: { water: 510, electric: 3010 },
    bundle: {
      rowsByCutoff: new Map([
        ['WATER', new Map([[3, { prev: 500, curr: 0 }]])],
        ['ELECTRIC', new Map([[3, { prev: 3000, curr: 0 }]])],
      ]),
      interimsAll: [],
    },
    deposits: new Map([[100, [
      deposit({ id: 901, tenant_id: 100, kind: 'ADVANCE', amount: 6750, ref_no: '5001' }),
      deposit({ id: 902, tenant_id: 100, kind: 'DEPOSIT', amount: 6750, ref_no: '7001' }),
    ]]]),
  }
}

// Early termination: planned Feb 28, out Nov 15; the advance was already credited on the Oct statement (stored credit).
export function earlyWithPriorCredit({ waived = false } = {}) {
  const t = tenant({ id: 110, name: 'Tenant Early', rate: 6000, move_in_date: '2026-09-01', move_out_date: '2027-02-28' })
  return {
    tenant: t, tenants: [t], cutoffs: CUTOFFS, moveOutDate: '2026-11-15', now: NOW,
    readings: {}, bundle: {},
    deposits: new Map([[110, [
      deposit({ id: 911, tenant_id: 110, kind: 'ADVANCE', amount: 6000, ref_no: '5101' }),
      deposit({ id: 912, tenant_id: 110, kind: 'DEPOSIT', amount: 6000, ref_no: '7101' }),
    ]]]),
    storedCredits: [{ id: 1, tenant_id: 110, cutoff_id: 2, amount: 6000, ref_text: 'S.I# 5101', allocations: [{ deposit_id: 911, amount: 6000 }] }],
    payments: new Map([[110, [
      payment({ id: 1, tenant_id: 110, cutoff_id: 3, category: 'RENT_WATER', amount: 1000 }),
      payment({ id: 2, tenant_id: 110, cutoff_id: 2, category: 'RENT_WATER', amount: 6000 }),
      payment({ id: 3, tenant_id: 110, cutoff_id: null, category: 'OTHER', amount: 500 }),
    ]]]),
    waived: new Map([[110, waived]]),
  }
}
