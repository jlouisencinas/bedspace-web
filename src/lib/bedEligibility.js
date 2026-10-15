// Pure helpers (no imports) so they can be exercised from plain Node.

// beds.status can drift from tenants (e.g. migrated tenants on a bed left RESERVED). A bed with an
// active tenant is LEASED; beds_with_tenant only joins active tenants, so tenant_id != null means one exists.
export function deriveBedStatuses(beds) {
  return beds.map(b => (b.tenant_id != null && b.status !== 'LEASED' ? { ...b, status: 'LEASED' } : b))
}

export function moveInEligibleBeds(beds, tenants) {
  const occupied = new Set()
  for (const t of tenants || []) {
    if (t.is_active && t.bed_id != null) occupied.add(t.bed_id)
  }
  return (beds || []).filter(b =>
    (b.status === 'VACANT' || b.status === 'RESERVED') && !occupied.has(b.bed_id))
}

export function activeTenantOnBedMessage(roomNo, bedLetter, tenantName) {
  const who = tenantName ? ` (${tenantName})` : ''
  return `Room ${roomNo} Bed ${bedLetter} already has an active tenant${who}. Move them out first, or fix the bed status.`
}

export function isActiveTenantPerBedViolation(err) {
  if (!err) return false
  return err.code === '23505' || String(err.message || '').includes('uniq_active_tenant_per_bed')
}
