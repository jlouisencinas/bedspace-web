/**
 * scripts/migrate_utilities.mjs
 * -----------------------------
 * Seed the May 2026 cutoff's meter readings from the Google Sheet
 * "Water & Electric Meter Reading" tab.
 *
 * Sheet column layout (per room row):
 *   0 room | 1 water prev | 2 water curr | 3 water cons | 4 water amount | 5 flag
 *   7 room | 8 elec prev  | 9 elec curr  | 10 elec cons | 11 elec amount
 *
 * Run:
 *   node scripts/migrate_utilities.mjs            # dry run
 *   node scripts/migrate_utilities.mjs --commit   # write to Supabase
 *
 * Prereq: run database/utilities_schema.sql first (creates the May 2026 cutoff).
 */

const SHEET_ID    = '1praSyiSfYjlT9i5w58D_KKpSaUQZvlQa'  // real masterdata workbook
const SHEET_GID   = '410912502'                          // Water & Electric Meter Reading tab
const CUTOFF_NAME = 'May 2026'

const SUPABASE_URL = 'https://hkminadjypkfmbkfcawx.supabase.co'
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhrbWluYWRqeXBrZm1ia2ZjYXd4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAzMjQ3MjcsImV4cCI6MjA5NTkwMDcyN30.DPe9gROKspyUZFGbSkJfIf0q82nhaT2pp8S_tRednU0'

const COMMIT = process.argv.includes('--commit')

// ── CSV parser ────────────────────────────────────────────────────────────────
function parseCSV(text) {
  const rows = []
  let row = [], field = '', q = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1]
    if (q) {
      if (c === '"' && n === '"') { field += '"'; i++ }
      else if (c === '"') q = false
      else field += c
    } else {
      if (c === '"') q = true
      else if (c === ',') { row.push(field); field = '' }
      else if (c === '\r') {}
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = '' }
      else field += c
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row) }
  return rows
}

const num = v => {
  if (v == null) return null
  const n = parseFloat(String(v).replace(/[^\d.-]/g, ''))
  return isNaN(n) ? null : n
}

function headers() {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    Prefer: 'resolution=merge-duplicates,return=minimal',
  }
}

async function getJson(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: headers() })
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`)
  return res.json()
}

async function upsert(rows) {
  if (!COMMIT || !rows.length) return
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/meter_readings?on_conflict=cutoff_id,room_id,utility`,
    { method: 'POST', headers: headers(), body: JSON.stringify(rows) }
  )
  if (!res.ok) throw new Error(`upsert: ${res.status} ${await res.text()}`)
}

async function main() {
  console.log(`${COMMIT ? 'COMMIT' : 'DRY RUN'} mode\n`)

  // 1. Cutoff (rates + id)
  const cutoffs = await getJson(`cutoffs?name=eq.${encodeURIComponent(CUTOFF_NAME)}&select=*`)
  if (!cutoffs.length) throw new Error(`Cutoff "${CUTOFF_NAME}" not found — run utilities_schema.sql first.`)
  const cutoff = cutoffs[0]
  const waterRate = num(cutoff.water_bedspace_rate) || 0
  const elecRate  = num(cutoff.electric_bedspace_rate) || 0
  console.log(`Cutoff: ${cutoff.name} (id ${cutoff.id})`)
  console.log(`  water bedspace ₱${waterRate}/m³  electric bedspace ₱${elecRate}/kWh\n`)

  // 2. Rooms map
  const rooms = await getJson('rooms?select=id,room_no,room_type')
  const roomMap = new Map(rooms.map(r => [String(r.room_no).trim(), r]))
  console.log(`Rooms: ${roomMap.size}\n`)

  // 3. Download sheet (by gid — exact tab)
  const csvUrl = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&gid=${SHEET_GID}`
  const csv = parseCSV(await (await fetch(csvUrl)).text())

  const rows = []
  let matched = 0, skipped = 0

  for (const r of csv) {
    const roomNo = String(r[0] || '').trim()
    const room = roomMap.get(roomNo)
    if (!room) { skipped++; continue }   // header/summary/unknown rows

    const wPrev = num(r[1]), wCurr = num(r[2])
    const ePrev = num(r[8]), eCurr = num(r[9])

    if (wPrev != null && wCurr != null) {
      rows.push({ cutoff_id: cutoff.id, room_id: room.id, utility: 'WATER',
                  previous_reading: wPrev, current_reading: wCurr, rate: waterRate })
    }
    if (ePrev != null && eCurr != null) {
      rows.push({ cutoff_id: cutoff.id, room_id: room.id, utility: 'ELECTRIC',
                  previous_reading: ePrev, current_reading: eCurr, rate: elecRate })
    }
    matched++
    console.log(`  ✓ Room ${roomNo}: water ${wPrev}→${wCurr}, electric ${ePrev}→${eCurr}`)
  }

  await upsert(rows)

  console.log('\n' + '='.repeat(50))
  console.log(`  Rooms matched   : ${matched}`)
  console.log(`  Readings to write: ${rows.length}`)
  console.log(`  Non-room rows   : ${skipped}`)
  console.log('='.repeat(50))
  console.log(COMMIT ? '\n✅ Done.' : '\nDRY RUN — re-run with --commit to write.')
}

main().catch(e => { console.error('\n❌', e.message); process.exit(1) })
