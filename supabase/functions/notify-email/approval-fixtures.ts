// Fictitious data only. Used by the admin "sample email" action (index.ts) and the preview
// script. Pure module: no Deno globals, erasable TypeScript only.
import { buildTicketEmail } from './ticket-email.ts'
import { buildDecisionEmail, buildRequestEmail, type ApprovalRow, type Built, type Ctx } from './approval-email.ts'

export const SAMPLE_KINDS = ['approval_request', 'approval_decision_approved', 'approval_decision_rejected', 'maintenance_ticket'] as const
export type SampleKind = typeof SAMPLE_KINDS[number]

export const SAMPLE_REQUESTER = 'staff.maria@example.com'
export const SAMPLE_DECIDER   = 'admin.rosa@example.com'

export function sampleRow(now: Date, status: 'PENDING' | 'APPROVED' | 'REJECTED'): ApprovalRow {
  const created = new Date(now.getTime() - 3 * 60 * 1000)
  return {
    id: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
    entity_type: 'TENANT',
    entity_id: '1042',
    field_name: 'tenant_profile',
    old_value: {
      fields: { permanent_address: '12 Rizal St, Quezon City', emergency_contact_no: '0917 555 1234' },
      contacts: [{ id: 1, value: '0917 555 4567', label: 'Mobile', isPrimary: true }],
    },
    new_value: {
      _tenant_name: 'Juan Dela Cruz',
      _room_no: '306',
      _bed_letter: 'B',
      fields: { permanent_address: '48 Mabini Ave, Pasig City', emergency_contact_no: '0917 555 9876' },
      contacts: [
        { id: 1, value: '0917 555 4567', label: 'Mobile', isPrimary: true },
        { id: null, value: '0918 555 2233', label: 'Work', isPrimary: false },
      ],
    },
    reason: 'Tenant moved to a new family address and added a work number.',
    status,
    decision_notes: status === 'REJECTED' ? 'Please attach proof of the new address first.' : status === 'APPROVED' ? 'Verified with the tenant.' : null,
    decided_at: status === 'PENDING' ? null : now.toISOString(),
    created_at: created.toISOString(),
  }
}

export function buildSampleEmail(kind: SampleKind, appUrl: string, now: Date = new Date()): Built {
  if (kind === 'maintenance_ticket') {
    const ticket = { id: 4821, raisedBy: SAMPLE_REQUESTER, roomNo: '702', tenantName: 'Juan Dela Cruz', concern: 'Leaking faucet in bathroom', remarks: 'Water drips constantly and pools under the sink. Tenant asked for a repair this week.', raisedAt: new Date(now.getTime() - 60 * 1000).toISOString() }
    return buildTicketEmail(ticket, { appUrl, sample: true })
  }
  const base: Ctx = { appUrl, requesterEmail: SAMPLE_REQUESTER, deciderEmail: SAMPLE_DECIDER, sample: true }
  if (kind === 'approval_request') return buildRequestEmail(sampleRow(now, 'PENDING'), base)
  const status = kind === 'approval_decision_approved' ? 'APPROVED' : 'REJECTED'
  return buildDecisionEmail(sampleRow(now, status), base, 'admin')
}
