// Display-only filter for Billing's Per Tenant rows: never changes amounts, totals or what prints.
export function filterBillingRows(rows, query) {
  const tokens = String(query ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!tokens.length) return rows
  return rows.filter(r => {
    const hay = [r.name, r.room_no, r.fromRoomNo, r.bed].filter(Boolean).map(String).join(' ').toLowerCase()
    return tokens.every(tok => hay.includes(tok))
  })
}
