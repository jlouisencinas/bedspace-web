/**
 * scripts/migrate.mjs
 * -------------------
 * Bulk-migrate tenants + bed statuses from the Google Sheet (MASTER DATA tab)
 * into Supabase. Node version — no extra dependencies (uses built-in fetch).
 *
 * Run:
 *   node scripts/migrate.mjs            # dry run (writes nothing)
 *   node scripts/migrate.mjs --commit   # actually write to Supabase
 */

// ── CONFIG ──────────────────────────────────────────────────────────────────
const SHEET_ID  = '1praSyiSfYjlT9i5w58D_KKpSaUQZvlQa'  // real masterdata
const SHEET_TAB = ''   // blank = use the first/default tab

const SUPABASE_URL = 'https://hkminadjypkfmbkfcawx.supabase.co'
// Paste your anon key (Supabase → Project Settings → API). RLS is disabled.
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhrbWluYWRqeXBrZm1ia2ZjYXd4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAzMjQ3MjcsImV4cCI6MjA5NTkwMDcyN30.DPe9gROKspyUZFGbSkJfIf0q82nhaT2pp8S_tRednU0'

const VALID_STATUS = new Set(['LEASED', 'VACANT', 'RESERVED', 'OUT OF ORDER'])
const COMMIT = process.argv.includes('--commit')

// ── CSV parser (handles quoted fields with commas) ───────────────────────────
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

function rowsToObjects(rows) {
  const headers = rows[0].map(h => h.trim())
  return rows.slice(1).map(r => {
    const o = {}
    headers.forEach((h, i) => { o[h] = (r[i] ?? '').trim() })
    return o
  })
}

// ── Field helpers ─────────────────────────────────────────────────────────────
function parseDate(v) {
  if (!v || !v.trim()) return null
  const s = v.trim()
  const months = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 }
  // "Aug 27, 2024" / "August 27, 2024"
  let m = s.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/)
  if (m) {
    const mi = months[m[1].slice(0,3).toLowerCase()]
    if (mi != null) return `${m[3]}-${String(mi+1).padStart(2,'0')}-${String(+m[2]).padStart(2,'0')}`
  }
  // "8/27/2024"
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (m) return `${m[3]}-${String(+m[1]).padStart(2,'0')}-${String(+m[2]).padStart(2,'0')}`
  // already "2024-08-27"
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  return null
}

function parseMoney(v) {
  if (!v || !v.trim()) return null
  const n = parseFloat(v.replace(/[^\d.]/g, ''))
  return isNaN(n) ? null : n
}

function clean(v) {
  const s = (v ?? '').trim()
  return s || null
}

// ── Supabase REST helpers ────────────────────────────────────────────────────
function headers() {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
  }
}

async function fetchBedMap() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/beds_with_tenant?select=bed_id,room_no,bed_letter`,
    { headers: headers() }
  )
  if (!res.ok) throw new Error(`Fetch beds failed: ${res.status} ${await res.text()}`)
  const map = new Map()
  for (const b of await res.json()) {
    map.set(`${String(b.room_no).trim()}|${String(b.bed_letter).trim().toUpperCase()}`, b.bed_id)
  }
  return map
}

async function fetchRoomMap() {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rooms?select=id,room_no`, { headers: headers() })
  if (!res.ok) throw new Error(`Fetch rooms failed: ${res.status} ${await res.text()}`)
  const map = new Map()
  for (const r of await res.json()) map.set(String(r.room_no).trim(), r.id)
  return map
}

// Create a bed when a LEASED row lands on a letter not yet in the app.
// Dry run returns a placeholder so the flow continues (and logs the recovery).
async function createBed(roomId, letter, status, rate) {
  if (!COMMIT) return `dry-${roomId}-${letter}`
  const res = await fetch(`${SUPABASE_URL}/rest/v1/beds`, {
    method: 'POST', headers: headers(),
    body: JSON.stringify({ room_id: roomId, bed_letter: letter, default_rate: rate, status }),
  })
  if (!res.ok) throw new Error(`Create bed failed: ${res.status} ${await res.text()}`)
  const [row] = await res.json()
  return row.id
}

async function setBedStatus(bedId, status) {
  if (!COMMIT) return
  const res = await fetch(`${SUPABASE_URL}/rest/v1/beds?id=eq.${bedId}`, {
    method: 'PATCH', headers: headers(), body: JSON.stringify({ status }),
  })
  if (!res.ok) throw new Error(`Set bed status failed: ${res.status} ${await res.text()}`)
}

async function insertTenant(bedId, data) {
  if (!COMMIT) return
  const res = await fetch(`${SUPABASE_URL}/rest/v1/tenants`, {
    method: 'POST', headers: headers(),
    body: JSON.stringify({ bed_id: bedId, is_active: true, ...data }),
  })
  if (!res.ok) throw new Error(`Insert tenant failed: ${res.status} ${await res.text()}`)
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  if (SUPABASE_KEY === 'PASTE_YOUR_ANON_KEY_HERE') {
    console.error('ERROR: Set SUPABASE_KEY at the top of scripts/migrate.mjs first.')
    process.exit(1)
  }
  console.log(`${COMMIT ? 'COMMIT' : 'DRY RUN'} mode\n`)

  // 1. Download sheet
  console.log('Downloading MASTER DATA from Google Sheets…')
  const csvUrl = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv`
    + (SHEET_TAB ? `&sheet=${encodeURIComponent(SHEET_TAB)}` : '')
  const csvRes = await fetch(csvUrl)
  if (!csvRes.ok) throw new Error(`Download failed: ${csvRes.status}`)
  const rows = rowsToObjects(parseCSV(await csvRes.text()))
  console.log(`  ${rows.length} rows found\n`)

  // 2. Build bed + room lookups
  console.log('Loading beds from Supabase…')
  const bedMap  = await fetchBedMap()
  const roomMap = await fetchRoomMap()
  console.log(`  ${bedMap.size} beds, ${roomMap.size} rooms available\n`)

  const stats = { leased: 0, statusOnly: 0, skipped: 0, noBed: 0 }

  for (let idx = 0; idx < rows.length; idx++) {
    const row = rows[idx]
    const rowNum = idx + 2
    const roomNo = clean(row['ROOM NO'])
    const bedRaw = clean(row['BED ASSIGNMENT'])
    let status   = (clean(row['BED STATUS']) || 'VACANT').toUpperCase()
    const name   = clean(row['NAME'])

    if (!roomNo || !bedRaw) { stats.skipped++; continue }
    if (!VALID_STATUS.has(status)) status = 'VACANT'

    const letters = bedRaw.toUpperCase().split('').filter(c => /[A-Z]/.test(c))
    if (!letters.length) { stats.skipped++; continue }

    for (const letter of letters) {
      let bedId = bedMap.get(`${roomNo}|${letter}`)
      if (!bedId) {
        // Auto-create the bed ONLY when a real (LEASED) tenant needs it — keeps
        // the layout in sync with the sheet without re-adding stale vacant beds.
        if (status === 'LEASED') {
          const roomId = roomMap.get(roomNo)
          if (roomId) {
            bedId = await createBed(roomId, letter, status, parseMoney(row['RATE']))
            bedMap.set(`${roomNo}|${letter}`, bedId)
            stats.created = (stats.created || 0) + 1
            console.log(`  ＋ created bed ${roomNo}-${letter} (for LEASED ${name || ''})`)
          }
        }
        if (!bedId) {
          console.log(`  ⚠️  Row ${rowNum}: no bed for Room ${roomNo} Bed ${letter} — skipped (vacant)`)
          stats.noBed++
          continue
        }
      }

      await setBedStatus(bedId, status)

      // Insert tenant only on the first letter (avoid dupes for multi-bed rows)
      if (status === 'LEASED' && name && letter === letters[0]) {
        const tenant = {
          tenant_no:              clean(row['TENANT NO']),
          name,
          gender:                 clean(row['GENDER']),
          rate:                   parseMoney(row['RATE']),
          duration:               clean(row['DURATION']),
          move_in_date:           parseDate(row['MOVE IN DATE']),
          move_out_date:          parseDate(row['MOVE OUT DATE']),
          last_pay_10th:          parseDate(row['LAST PAYMENT DATE 10th']),
          last_pay_eom:           parseDate(row['LAST PAYMENT DATE EOM']),
          contact_no:             clean(row['CONTACT NO']),
          email:                  clean(row['EMAIL']),
          location_of_work:       clean(row['LOCATION OF WORK']),
          work_schedule:          clean(row['WORK SCHEDULE']),
          govt_id1:               clean(row['GOVT ID1']),
          govt_id2:               clean(row['GOVT ID 2']),
          contract:               clean(row['CONTRACT'] || row['CONRACT']),
          emergency_contact_name: clean(row['EMERGENCY CONTACT NAME']),
          emergency_contact_no:   clean(row['EMERGENCY CONTACT NO'] || row['EMERGENCY CONTACT NO.']),
          comments:               clean(row['COMMENTS']),
        }
        Object.keys(tenant).forEach(k => tenant[k] == null && delete tenant[k])
        await insertTenant(bedId, tenant)
        stats.leased++
        console.log(`  ✓ Room ${roomNo} Bed ${letter}: ${name} (${status})`)
      } else {
        stats.statusOnly++
      }
    }
  }

  console.log('\n' + '='.repeat(50))
  console.log(`  Tenants migrated : ${stats.leased}`)
  console.log(`  Beds status-only : ${stats.statusOnly}`)
  console.log(`  Rows skipped     : ${stats.skipped}`)
  console.log(`  Beds auto-created: ${stats.created || 0}`)
  console.log(`  Beds not matched : ${stats.noBed} (vacant stale rows)`)
  console.log('='.repeat(50))
  console.log(COMMIT ? '\n✅ Migration complete.' : '\nDRY RUN — re-run with --commit to write.')
}

main().catch(err => { console.error('\n❌', err.message); process.exit(1) })
