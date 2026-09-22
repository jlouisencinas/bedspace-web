// Occupancy Simulator: CSV parsing + validation for the admin bulk re-import.
// Pure functions, no npm deps — manual char-by-char parser mirroring
// scripts/migrate.mjs's parseCSV(), since this repo doesn't use PapaParse.
//
// Expected header: `ROOM NO,ROOM TYPE, RATE ,BED ASSIGNMENT,beds`
// The `beds` column (bed count) is a merged-cell artifact, populated only on
// each room's first row — it is never trusted; bed count is always derived
// by grouping rows by room_no.

function parseCSV(text) {
  const rows = []
  let row = [], field = '', inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i], next = text[i + 1]
    if (inQuotes) {
      if (c === '"' && next === '"') { field += '"'; i++ }
      else if (c === '"') { inQuotes = false }
      else { field += c }
    } else {
      if (c === '"') { inQuotes = true }
      else if (c === ',') { row.push(field); field = '' }
      else if (c === '\r') { /* skip */ }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = '' }
      else { field += c }
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row) }
  return rows
}

export function parseSimCsv(text) {
  const rows = parseCSV(text).filter(r => r.some(c => c.trim() !== ''))
  if (rows.length === 0) return []
  const headers = rows[0].map(h => h.trim().toUpperCase())
  return rows.slice(1).map(r => {
    const o = {}
    headers.forEach((h, i) => { o[h] = (r[i] ?? '').trim() })
    return o
  })
}

function parseRate(raw) {
  const s = (raw || '').trim()
  if (/out.?of.?order/i.test(s)) return { rate: null, is_out_of_order: true, error: null }
  const isNegative = s.startsWith('-')
  const stripped = s.replace(/[^\d.]/g, '')
  if (!stripped) return { rate: null, is_out_of_order: false, error: 'empty RATE' }
  const n = parseFloat(stripped)
  if (isNaN(n)) return { rate: null, is_out_of_order: false, error: `unparseable RATE value "${raw}"` }
  if (isNegative || n < 0) return { rate: null, is_out_of_order: false, error: `RATE must be positive, got "${raw}"` }
  return { rate: n, is_out_of_order: false, error: null }
}

// Returns { rooms, errors }. rooms is [] whenever errors.length > 0 — validation
// happens entirely before any RPC call, so a malformed file writes nothing.
export function validateSimRows(rows) {
  const errors = []
  const roomsByNo = new Map() // room_no -> { room_no, room_type, floor, beds: [] }
  const seenBedKeys = new Set()

  rows.forEach((r, idx) => {
    const rowNum = idx + 2 // +1 for header, +1 for 1-based display
    const room_no = (r['ROOM NO'] || '').trim()
    const room_type = (r['ROOM TYPE'] || '').trim()
    const bed_letter = (r['BED ASSIGNMENT'] || '').trim().toUpperCase()
    const rateRaw = r['RATE'] ?? ''

    if (!room_no) { errors.push(`Row ${rowNum}: missing ROOM NO`); return }
    if (!bed_letter) { errors.push(`Row ${rowNum}: missing BED ASSIGNMENT`); return }
    if (!room_type) { errors.push(`Row ${rowNum}: missing ROOM TYPE`); return }

    const { rate, is_out_of_order, error } = parseRate(rateRaw)
    if (error) { errors.push(`Row ${rowNum}: ${error}`); return }

    const bedKey = `${room_no}|${bed_letter}`
    if (seenBedKeys.has(bedKey)) {
      errors.push(`Row ${rowNum}: duplicate bed — Room ${room_no}, Bed ${bed_letter} already appears earlier in this file`)
      return
    }
    seenBedKeys.add(bedKey)

    if (!roomsByNo.has(room_no)) {
      const floor = parseInt(room_no.trim()[0], 10)
      roomsByNo.set(room_no, {
        room_no, room_type,
        floor: isNaN(floor) ? null : floor,
        beds: [],
      })
    }
    roomsByNo.get(room_no).beds.push({ bed_letter, rate, is_out_of_order })
  })

  if (errors.length > 0) return { rooms: [], errors }
  return { rooms: [...roomsByNo.values()], errors: [] }
}
