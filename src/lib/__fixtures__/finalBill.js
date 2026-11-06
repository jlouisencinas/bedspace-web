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

// Stay extension: a one-month stay Oct 2 -> contract Nov 2, moved out Nov 5 (rate 10,000). Start readings typed by staff.
export function lateOneMonth({ afterNoon = true } = {}) {
  const t = tenant({ id: 120, name: 'Tenant Late', rate: 10000, move_in_date: '2026-10-02', move_out_date: '2026-11-02' })
  return {
    tenant: t, tenants: [t], cutoffs: CUTOFFS, moveOutDate: '2026-11-05', now: NOW, vacatedAfterNoon: afterNoon,
    readings: { water: 104, electric: 1100 }, startOverrides: { WATER: 100, ELECTRIC: 1000 },
    bundle: {
      rowsByCutoff: new Map([
        ['WATER', new Map([[2, { prev: 90, curr: 102 }], [3, { prev: 102, curr: 0 }]])],
        ['ELECTRIC', new Map([[2, { prev: 950, curr: 1080 }], [3, { prev: 1080, curr: 0 }]])],
      ]),
      interimsAll: [],
    },
    deposits: new Map([[120, [
      deposit({ id: 921, tenant_id: 120, kind: 'ADVANCE', amount: 10000, ref_no: '5201' }),
      deposit({ id: 922, tenant_id: 120, kind: 'DEPOSIT', amount: 10000, ref_no: '7201' }),
    ]]]),
  }
}

// The same move-out as saved by staff before the EXTENSION line existed: a typed "Stay Extension" on a rent line.
export function typedExtensionBill() {
  return {
    id: 26, tenant_id: 120, status: 'FINAL', move_out_date: '2026-11-05', refund_status: 'PENDING', net_amount: -4585.85,
    covered_cutoffs: [2], details: { water: { prev: 100, curr: 104 }, electric: { prev: 1000, curr: 1100 } },
    lines: [
      { label: 'Rent Period (1 Month)', mid: '02 October - 02 November', amount: 10000, computed: 9677.42, kind: 'charge', source: 'RENT' },
      { label: 'Stay Extension ', mid: '02 November - 05 November', amount: 2000, computed: 1666.67, kind: 'charge', source: 'RENT' },
      { label: 'Add: Water (cu. m)', mid: '4.00', rate: 155.037488, amount: 620.15, computed: 620.15, kind: 'charge', source: 'WATER' },
      { label: 'Add: Electricity (per kWh)', mid: '127.00', rate: 22, amount: 2794, computed: 2794, kind: 'charge', source: 'ELECTRIC' },
      { label: 'Less: Advanced Payment', mid: 'S.I# 5201 · no earlier credit on record', amount: -10000, kind: 'credit', source: 'ADVANCE', deposit_ids: [921] },
      { label: 'Less: Deposit Payment', mid: 'TR# 7201', amount: -10000, kind: 'credit', source: 'DEPOSIT', deposit_ids: [922] },
    ],
  }
}
