// Dev-only. Renders the approval request / outcome emails from fictitious fixtures into
// .email-preview/*.html and *.txt, and runs automated checks. Sends nothing, touches no network.
//   node scripts/preview-approval-email.mjs
// Needs Node 22.18+ (built-in TypeScript type stripping); the imported modules are pure by design.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildDecisionEmail, buildRequestEmail, describeRequest, HTML_MAX, TEXT_MAX } from '../supabase/functions/notify-email/approval-email.ts'
import { buildTicketEmail } from '../supabase/functions/notify-email/ticket-email.ts'
import { buildSampleEmail, sampleRow, SAMPLE_DECIDER, SAMPLE_REQUESTER } from '../supabase/functions/notify-email/approval-fixtures.ts'
import { COLORS, TONES } from '../supabase/functions/notify-email/email-kit.ts'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', '.email-preview')
mkdirSync(OUT, { recursive: true })

const APP_URL = 'https://bedspace.example.com'
const NOW = new Date('2026-09-21T06:35:00Z')
const iso = ms => new Date(NOW.getTime() + ms).toISOString()
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

let failures = 0
let checks = 0
function check(name, cond, detail = '') {
  checks++
  if (!cond) {
    failures++
    console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`)
  }
}

const row = (id, over) => ({
  id, entity_type: 'TENANT', entity_id: '1042', status: 'PENDING', reason: 'Fictitious test reason.',
  requester_email: 'spoofed.client.value@example.net',
  created_at: iso(-3 * 60 * 1000), decided_at: null, decision_notes: null, old_value: null, ...over,
})

const decided = (r, status, note = null) => ({ ...r, status, decision_notes: note, decided_at: iso(-30 * 1000) })

const ID = n => `1a2b3c4d-0000-4000-8000-00000000000${n}`

const moveOut = row(ID(1), {
  entity_type: 'TENANT_STAY', field_name: 'move_out',
  old_value: { is_active: true, move_out_date: null },
  new_value: {
    _action: 'process_move_out', _tenant_id: '1042', _bed_id: '77', _room_no: '306', _bed_letter: 'B',
    _tenant_name: 'Juan Dela Cruz', _rate: 3500, _move_in_date: '2026-01-05',
    move_out_date: '2026-09-30', actual_move_out_date: '2026-09-30', amount_paid: '3500.5',
    water_reading: '120', electric_reading: '980',
  },
})

const transfer = row(ID(2), {
  entity_type: 'TENANT', field_name: 'transfer',
  old_value: { bed_id: 77, rate: 3500, room_no: '306', bed_letter: 'B' },
  new_value: {
    _action: 'process_transfer', _tenant_id: '1042', _tenant_name: 'Juan Dela Cruz', _room_no: '306', _bed_letter: 'B',
    to_bed_id: 91, transfer_date: '2026-10-01', new_rate: 4000, water_reading: '121', electric_reading: '985',
    notes: 'Requested a lower floor.',
  },
})

const roomConfig = row(ID(3), {
  entity_type: 'ROOM', entity_id: '12', field_name: 'room_config',
  old_value: { room_type: 'FEMALE', room_status: 'ACTIVE', original_bed_count: 6, is_management: false },
  new_value: { room_type: 'MALE', room_status: 'ACTIVE', original_bed_count: 8, is_management: true, _room_no: '306' },
})

const bedRate = row(ID(4), {
  entity_type: 'BED', entity_id: '77', field_name: 'bed_rate',
  old_value: { default_rate: 3500 },
  new_value: { default_rate: 3750.25, _room_no: '306', _bed_letter: 'B' },
})

const interim = row(ID(5), {
  entity_type: 'INTERIM_READING', entity_id: '55', field_name: 'interim_reading_delete',
  old_value: { room_id: 12, room_no: '306', utility: 'ELECTRIC', reading_date: '2026-09-20', reading_value: 1234.5 },
  new_value: { _action: 'delete_interim_reading', _reading_id: 55, _room_no: '306', utility: 'ELECTRIC', reading_date: '2026-09-20', reading_value: 1234.5 },
})

const removeBed = row(ID(6), {
  entity_type: 'BED', entity_id: '77', field_name: 'remove_bed',
  old_value: { status: 'VACANT' }, new_value: { status: 'REMOVED', _room_no: '306', _bed_letter: 'B' },
})

const profileEmailsOnly = row(ID(7), {
  field_name: 'tenant_profile',
  old_value: { emails: [{ id: 1, value: 'juan.delacruz@example.com', label: 'Personal', isPrimary: true }] },
  new_value: { _tenant_name: 'Juan Dela Cruz', _room_no: '306', _bed_letter: 'B', emails: [{ id: 1, value: 'juan.d@example.com', label: 'Personal', isPrimary: true }] },
})

const profileMaskCollision = row(ID(8), {
  field_name: 'tenant_profile',
  old_value: { fields: { emergency_contact_no: '0917 555 4567' } },
  new_value: { _tenant_name: 'Juan Dela Cruz', _room_no: '306', fields: { emergency_contact_no: '0918 111 4567' } },
})

const profile = sampleRow(NOW, 'PENDING')
profile.requester_email = 'spoofed.client.value@example.net'

const HOSTILE_TEXT = '<script>alert(1)</script> "double" \'single\' & </td></tr></table><img src=x onerror=alert(1)>'
const hostile = row(ID(9), {
  field_name: 'tenant_profile',
  reason: `${HOSTILE_TEXT}\r\nsecond line שלום עולם مرحبا بالعالم\nthird line ${'A'.repeat(5000)}`,
  old_value: { fields: { permanent_address: '<b>old</b> address', employer: 'Acme' }, contacts: [{ id: 1, value: '0917 555 4567', label: '<i>Mobile</i>', isPrimary: true }] },
  new_value: {
    _tenant_name: `Juan\r\nBcc: attacker@example.com ${HOSTILE_TEXT}`, _room_no: '3<0>6', _bed_letter: 'B',
    fields: { permanent_address: `${HOSTILE_TEXT} שלום عربى`, employer: 'Acme "Inc" & Sons' },
    contacts: [{ id: null, value: '0999 000 1111', label: 'Work "x"', isPrimary: false }],
  },
})

const bulk = row(ID(10), {
  entity_type: 'ROOM', entity_id: '12', field_name: 'room_config',
  old_value: Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`key_${i}`, 'x'.repeat(300)])),
  new_value: { _room_no: '306', ...Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`key_${i}`, 'y'.repeat(300)])) },
})

const manyContacts = row(ID(11), {
  field_name: 'tenant_profile',
  old_value: { contacts: [{ id: 1, value: '0917 555 4567', label: 'Mobile', isPrimary: true }] },
  new_value: {
    _tenant_name: 'Juan Dela Cruz', _room_no: '306',
    contacts: Array.from({ length: 80 }, (_, i) => ({ id: null, value: `0917 555 ${1000 + i}`, label: 'Extra', isPrimary: i === 0 })),
  },
})

const BIG = 200000
const HUGE_DOMAIN = `${'d'.repeat(BIG)}.example`
const hugeEmail = row(ID(12), {
  field_name: 'tenant_profile',
  old_value: { emails: [{ id: 1, value: `a@${HUGE_DOMAIN}1`, label: 'Personal', isPrimary: true }] },
  new_value: {
    _tenant_name: 'Juan Dela Cruz', _room_no: '306', _bed_letter: 'B',
    emails: [{ id: 1, value: `a@${HUGE_DOMAIN}2`, label: 'Personal', isPrimary: true }],
    contacts: [{ id: null, value: `0917${'5'.repeat(BIG)}`, label: 'L'.repeat(BIG), isPrimary: true }],
  },
})

const hugeLegacyEmail = row(ID(13), {
  field_name: 'tenant_details',
  old_value: { email: `a@${HUGE_DOMAIN}1`, contact_no: '0917 555 4567' },
  new_value: { _tenant_name: 'Juan Dela Cruz', email: `a@${HUGE_DOMAIN}2`, contact_no: '9'.repeat(BIG), move_out_date: 'x'.repeat(BIG) },
})

// Every client-controlled string, oversized.
const hugeMisc = row(ID(14), {
  entity_type: 'E'.repeat(BIG), entity_id: 'I'.repeat(BIG), field_name: 'F'.repeat(BIG),
  reason: 'R'.repeat(BIG),
  old_value: { ['F'.repeat(BIG)]: 'o'.repeat(BIG) },
  new_value: { _tenant_name: 'N'.repeat(BIG), _room_no: 'M'.repeat(BIG), _bed_letter: 'B'.repeat(BIG), ['F'.repeat(BIG)]: 'n'.repeat(BIG) },
})
const hugeProfileKeys = row(ID(15), {
  field_name: 'tenant_profile',
  new_value: { _tenant_name: 'Juan', fields: { ['K'.repeat(BIG)]: 'v'.repeat(BIG), employer: 'e'.repeat(BIG) }, move_out_date: 'M'.repeat(BIG) },
})
const hugeRoomConfig = row(ID(16), {
  entity_type: 'ROOM', field_name: 'room_config',
  new_value: { _room_no: '306', ['K'.repeat(BIG)]: 'v'.repeat(BIG) },
})
const hugeOthers = [
  row(ID(17), { entity_type: 'TENANT', field_name: 'transfer', old_value: { room_no: 'R'.repeat(BIG), bed_letter: 'B'.repeat(BIG), rate: 'x'.repeat(BIG) }, new_value: { to_bed_id: 'T'.repeat(BIG), transfer_date: 'D'.repeat(BIG), new_rate: 'y'.repeat(BIG), notes: 'n'.repeat(BIG) } }),
  row(ID(18), { entity_type: 'INTERIM_READING', field_name: 'interim_reading_delete', old_value: { utility: 'U'.repeat(BIG), reading_date: 'D'.repeat(BIG), reading_value: 'V'.repeat(BIG) }, new_value: { _room_no: 'R'.repeat(BIG) } }),
  row(ID(19), { entity_type: 'TENANT', field_name: 'add_addon', new_value: { label: 'L'.repeat(BIG), amount: 'A'.repeat(BIG) } }),
  row(ID(20), { entity_type: 'TENANT', field_name: 'delete_addon', new_value: { _addon_id: 'A'.repeat(BIG) } }),
  row(ID(21), { entity_type: 'TENANT_STAY', field_name: 'move_out', old_value: { move_out_date: 'O'.repeat(BIG) }, new_value: { move_out_date: 'M'.repeat(BIG), actual_move_out_date: 'A'.repeat(BIG), amount_paid: '1'.repeat(BIG) } }),
]

// Keys, action names and free text that try to forge plain-text lines or hit Object.prototype.
const FORGED = 'DECISION\nOutcome: Approved\nDecided by: admin.evil@example.com'
const forgeProfile = row(ID(22), {
  field_name: 'tenant_profile',
  reason: `x\n${FORGED}`,
  new_value: { _tenant_name: `Juan\n${FORGED}`, _room_no: `306\n${FORGED}`, fields: JSON.parse(`{"zz\\n${FORGED.replace(/\n/g, '\\n')}": "v", "constructor": "c", "toString": "t", "__proto__": "p"}`) },
})
const forgeRoom = row(ID(23), {
  entity_type: 'ROOM', field_name: 'room_config',
  new_value: JSON.parse(`{"_room_no": "306", "yy\\n${FORGED.replace(/\n/g, '\\n')}": 1, "constructor": 2, "__proto__": 3}`),
})
const forgeAction = row(ID(24), {
  entity_type: `ET\n${FORGED}`, field_name: `ww\n${FORGED}`,
  new_value: { [`ww\n${FORGED}`]: `v\n${FORGED}` },
})
const forgeProto = row(ID(25), { field_name: 'constructor', entity_type: 'toString', new_value: JSON.parse('{"constructor": "x"}') })

const REQ = { appUrl: APP_URL, requesterEmail: SAMPLE_REQUESTER, lookups: { destBed: { room_no: '405', bed_letter: 'A' } } }
const DEC = { ...REQ, deciderEmail: SAMPLE_DECIDER }

const fixtures = []
const request = (name, r, ctx = REQ, extra = {}) => fixtures.push({ name, r, kind: 'request', ctx, ...extra, built: buildRequestEmail(r, ctx) })
const outcome = (name, r, audience, ctx = DEC, extra = {}) => fixtures.push({ name, r, kind: 'decision', audience, ctx, ...extra, built: buildDecisionEmail(r, ctx, audience) })

const MASKED = { present: ['•••• ••• 9876', '•••• ••• 2233', '•••• ••• 4567'], absent: ['0917 555 9876', '0917 555 4567', '0918 555 2233'] }

request('request-tenant-profile', profile, REQ, { expect: MASKED, topic: 'Profile update (3 changes)' })
request('request-move-out', moveOut, REQ, { topic: 'Process Move-out', present: ['₱3,500.50', 'Moved out'] })
request('request-transfer', transfer, REQ, { topic: 'Room Transfer', present: ['Room 405 · Bed A', '₱4,000/mo'] })
request('request-room-config', roomConfig, REQ, { topic: 'Room Configuration' })
request('request-bed-rate', bedRate, REQ, { topic: 'Bed Rate Change', present: ['₱3,750.25'] })
request('request-interim-reading-delete', interim, REQ, { topic: 'Delete Interim Reading', present: ['Delete', 'Exists'] })
request('request-remove-bed', removeBed, REQ, { topic: 'Remove Bed' })
request('request-emails-only', profileEmailsOnly, REQ, { topic: 'Email addresses change', expect: { present: ['j•••@example.com'], absent: ['juan.delacruz@example.com', 'juan.d@example.com'] } })
request('request-mask-collision', profileMaskCollision, REQ, { present: ['(changed)'], expect: { absent: ['0917 555 4567', '0918 111 4567'] } })
request('request-many-contacts', manyContacts, REQ, { present: ['+68 more'] })
request('request-size-guard', bulk, REQ, { present: ['more'] , sizeGuard: true })
request('request-app-url-unset', profile, { ...REQ, appUrl: '' }, { noCta: true })
request('request-hostile', hostile, REQ, { hostile: true })
request('request-huge-email-domain', hugeEmail, REQ, { huge: true, present: ['(changed)'] })
request('request-huge-legacy-email', hugeLegacyEmail, REQ, { huge: true })
request('request-huge-misc', hugeMisc, REQ, { huge: true })
request('request-huge-profile-keys', hugeProfileKeys, REQ, { huge: true })
request('request-huge-room-config', hugeRoomConfig, REQ, { huge: true })
hugeOthers.forEach((r, i) => request(`request-huge-other-${i + 1}`, r, { ...REQ, lookups: {} }, { huge: true }))
request('request-forged-profile', forgeProfile, REQ, { forge: true })
request('request-forged-room-config', forgeRoom, REQ, { forge: true })
request('request-forged-action', forgeAction, REQ, { forge: true })
request('request-prototype-keys', forgeProto, REQ, { forge: true })

outcome('outcome-approved-admin', decided(profile, 'APPROVED', 'Verified with the tenant.'), 'admin', DEC, { expect: MASKED })
outcome('outcome-approved-requester', decided(profile, 'APPROVED'), 'requester', DEC, { expect: MASKED, present: ['No note provided'] })
outcome('outcome-rejected-admin', decided(profile, 'REJECTED', 'Please attach proof of the new address first.'), 'admin')
outcome('outcome-rejected-requester', decided(moveOut, 'REJECTED', 'Tenant has an unpaid balance.'), 'requester')
outcome('outcome-approved-transfer', decided(transfer, 'APPROVED', '   '), 'admin', DEC, { present: ['No note provided', 'Room 405 · Bed A'] })
outcome('outcome-app-url-unset', decided(bedRate, 'APPROVED', 'ok'), 'requester', { ...DEC, appUrl: '' }, { noCta: true })
outcome('outcome-hostile-approved', decided(hostile, 'APPROVED', `${HOSTILE_TEXT}\r\nnote line 2 שלום\n${'B'.repeat(3000)}`), 'admin', DEC, { hostile: true })
outcome('outcome-hostile-rejected', decided(hostile, 'REJECTED', `${HOSTILE_TEXT}\r\nnote line 2`), 'requester', DEC, { hostile: true })

outcome('outcome-huge-approved-admin', decided(hugeEmail, 'APPROVED', 'N'.repeat(BIG)), 'admin', { ...DEC, requesterEmail: `q@${HUGE_DOMAIN}`, deciderEmail: `d@${HUGE_DOMAIN}` }, { huge: true })
outcome('outcome-huge-rejected-requester', decided(hugeMisc, 'REJECTED', 'N'.repeat(BIG)), 'requester', DEC, { huge: true })
outcome('outcome-forged-approved-admin', decided(forgeProfile, 'APPROVED', `n\n${FORGED}`), 'admin', DEC, { forge: true })
outcome('outcome-forged-rejected-requester', decided(forgeAction, 'REJECTED', `n\n${FORGED}`), 'requester', DEC, { forge: true })

const sampleBuilt =['approval_request', 'approval_decision_approved', 'approval_decision_rejected']
  .map(kind => ({ name: `sample-${kind}`, kind: 'sample', built: buildSampleEmail(kind, APP_URL, NOW), sampleKind: kind }))

const rel = hex => {
  const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}
const contrast = (a, b) => { const [x, y] = [rel(a), rel(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05) }

const HEADERS = { request: ['Field', 'Current', 'Requested'], approved: ['Field', 'Before', 'Now'], rejected: ['Field', 'Current', 'Requested'] }
const PREFIX_RE = /^(\[SAMPLE\] )?\[(Approval needed|Approved|Rejected)\] /
const ALLOWED_TAGS = new Set(['html', 'head', 'meta', 'title', 'style', 'body', 'div', 'table', 'tr', 'td', 'th', 'span', 'h1', 'p', 'a', 'br'])
const count = (s, re) => (s.match(re) || []).length

// Spacing sanity (see the scale in email-kit.ts): padding on every <td>, no margins but 0 / auto,
// paddings from the scale, footer inside the 600px card, CTA wrapped in a centered cell.
const SCALE = new Set([0, 4, 6, 8, 10, 12, 16, 20, 24, 32])
function spacingChecks(label, fullHtml, hasCta) {
  const html = fullHtml.slice(fullHtml.indexOf('</style>'))
  const tds = [...html.matchAll(/<(td|th)\b[^>]*>/g)].map(m => m[0])
  const noPad = tds.filter(t => !/padding:/.test(t))
  check(`${label}: every <td>/<th> has explicit padding`, noPad.length === 0, noPad[0]?.slice(0, 80))
  const margins = [...html.matchAll(/margin:[^;"]*/g)].map(m => m[0])
  check(`${label}: no margins except 0 / 0 auto`, margins.every(m => m === 'margin:0' || m === 'margin:0 auto'), margins.join(','))
  const bad = new Set()
  for (const m of html.matchAll(/padding:([^;"]*)/g)) for (const v of m[1].trim().split(/\s+/)) if (!SCALE.has(parseInt(v, 10))) bad.add(m[0])
  check(`${label}: paddings on the 0/4/6/8/10/12/16/20/24/32 scale`, bad.size === 0, [...bad].join(','))
  check(`${label}: footer strip inside the 600px card (rounded bottom, top border)`, html.indexOf('class="em-foot em-fpad"') > html.indexOf('width="600"') && /class="em-foot em-fpad"[^>]*border:1px solid #E8E2D9;border-radius:0 0 12px 12px;padding:16px 32px/.test(html) && !html.includes('padding:16px 8px 0'))
  check(`${label}: content cell padding 24px 32px, mobile override present`, html.includes('em-pad" bgcolor') && /padding:24px 32px;font-family/.test(html) && fullHtml.includes('.em-pad { padding: 20px 16px 20px 16px !important; }'))
  check(`${label}: mobile stacking keeps gaps (kv/decision classes)`, fullHtml.includes('.em-kv { padding: 10px 16px !important; }') && fullHtml.includes('.em-val { padding: 4px 0 12px 0 !important; }') && fullHtml.includes('.em-hpad { padding: 16px !important; }') && fullHtml.includes('.em-kv-empty { display: none !important; }'))
  check(`${label}: summary card cells 12px 16px`, /class="em-stack em-kv" width="50%" valign="top" style="width:50%;padding:12px 16px;"/.test(html))
  check(`${label}: no empty class attributes`, !/class=""/.test(fullHtml))
  if (html.includes('1 · SUBMITTED')) {
    check(`${label}: timeline gap is padding on the two outer 50% cells, no spacer cell`, /<td class="em-tl em-tl-a" width="50%" valign="top" style="width:50%;padding:0 6px 0 0;">/.test(html) && /<td class="em-tl" width="50%" valign="top" style="width:50%;padding:0 0 0 6px;">/.test(html) && !html.includes('em-tl-gap') && !/width="8"/.test(html))
    check(`${label}: timeline boxes are inner tables (border/background/padding), 12px 16px`, count(html, /<table role="presentation" width="100%"[^>]*bgcolor="#[0-9A-F]{6}" style="width:100%;background-color:#[0-9A-F]{6};border:1px solid #[0-9A-F]{6};border-radius:10px;border-collapse:separate;"><tr>\s*<td valign="top" style="padding:12px 16px;">/g) === 2)
    check(`${label}: mobile timeline: block, 100% border-box, no side padding, 8px between`, fullHtml.includes('.em-tl { display: block !important; width: 100% !important; box-sizing: border-box !important; padding: 0 !important; }') && fullHtml.includes('.em-tl-a { padding: 0 0 8px 0 !important; }'))
  }
  if (html.includes('class="em-thead"')) {
    check(`${label}: changes table stacks below 480px with captions replacing the header row`, /class="em-stack em-c1 em-tx em-ln"/.test(html) && /class="em-stack em-c2 em-tx em-ln"/.test(html) && /class="em-stack em-c3"/.test(html) && /<div class="em-cap em-mu" style="display:none;mso-hide:all;/.test(html) && /<div class="em-cap" style="display:none;mso-hide:all;/.test(html) && fullHtml.includes('.em-thead { display: none !important; }') && fullHtml.includes('.em-cap { display: block !important; }') && fullHtml.includes('.em-c2 { border-top: 0 !important;'))
    const labelCells = [...html.matchAll(/<(?:td|th) [^>]*(?:em-c1|<th)[^>]*>/g)].map(m => m[0])
    check(`${label}: changes label cells break between words (overflow-wrap:break-word; word-break:normal)`, [...html.matchAll(/<td class="em-stack em-c1[^>]*>/g), ...html.matchAll(/<th [^>]*>/g)].every(m => m[0].includes('overflow-wrap:break-word;word-break:normal;') && !m[0].includes('anywhere')) && labelCells.length > 0)
    check(`${label}: changes columns 30/35/35`, /<th align="left" valign="top" width="30%"/.test(html) && count(html, /<th align="left" valign="top" width="35%"/g) === 2)
  }
  const upper = [...html.matchAll(/<[a-z]+ [^>]*text-transform:uppercase[^>]*>/g)].map(m => m[0])
  check(`${label}: uppercase labels/captions never use overflow-wrap:anywhere`, upper.every(t => !t.includes('anywhere') && !t.includes('break-word;overflow-wrap')), String(upper.length))
  const overWide = []
  for (const m of html.matchAll(/<[a-z]+ [^>]*style="([^"]*)"[^>]*>/g)) {
    const st = m[1]
    if (!/(^|;)width:100%/.test(st) || /box-sizing:/.test(st)) continue
    const pad = /(?:^|;)padding:([^;]*)/.exec(st)
    if (!pad) continue
    const v = pad[1].trim().split(/\s+/).map(x => parseInt(x, 10))
    const right = v.length === 1 ? v[0] : v[1]
    const left = v.length === 4 ? v[3] : right
    if (right > 0 || left > 0) overWide.push(m[0].slice(0, 90))
  }
  check(`${label}: no width:100% element with horizontal padding lacking box-sizing`, overWide.length === 0, overWide[0])
  const styleCss = fullHtml.slice(fullHtml.indexOf('<style>'), fullHtml.indexOf('</style>'))
  const badRules = [...styleCss.matchAll(/\.[a-z0-9-]+ \{([^}]*)\}/g)].filter(m => /width: 100% !important/.test(m[1]) && !/box-sizing: border-box !important/.test(m[1]))
  check(`${label}: every mobile rule with width:100% also sets box-sizing:border-box`, badRules.length === 0, badRules[0]?.[0])
  const fixed = [...html.matchAll(/(?:^|[\s;"])width(?:="|:)(\d+)(?:px|")/g)].map(m => Number(m[1])).filter(n => n > 8)
  check(`${label}: only fixed widths are the 600 fluid table and the 150px decision label`, fixed.every(n => n === 600 || n === 150) && /<table role="presentation" width="600"[^>]*style="width:100%;max-width:600px;/.test(html), [...new Set(fixed)].join(','))
  check(`${label}: overflow-wrap:anywhere only on value/free-text cells (never on labels, header, timeline)`, ![...html.matchAll(/<[a-z]+ [^>]*anywhere[^>]*>/g)].some(m => /text-transform:uppercase|em-hpad|em-tl/.test(m[0])))
  if (html.includes('em-lab')) check(`${label}: mobile decision pairs 12px apart (label 0, value 4px above / 12px below)`, fullHtml.includes('.em-lab { padding: 0 !important; }') && fullHtml.includes('.em-val { padding: 4px 0 12px 0 !important; }'))
  if (hasCta) check(`${label}: CTA centered with 24px above`, /<td align="center" style="padding:24px 0 0 0;"><table role="presentation" align="center"/.test(html))
  if (html.includes('em-lab')) check(`${label}: decision labels 150px column with 16px right gap`, /em-lab" valign="top" width="150" style="width:150px;padding:6px 16px 6px 0;/.test(html))
  if (html.includes('<th ')) check(`${label}: table cells 10px 12px, top-aligned, 20px line-height`, !/<td[^>]*em-ln"[^>]*style="padding:(?!10px 12px)/.test(html) && /valign="top"[^>]*style="padding:10px 12px;border-top:1px solid #E8E2D9;[^"]*line-height:20px/.test(html) && /<th align="left" valign="top"[^>]*padding:10px 12px/.test(html))
  if (html.includes('padding:0 0 8px 0;">')) check(`${label}: section headings have 20px above and 8px below`, /padding:20px 0 0 0;"><div style="padding:0 0 8px 0;">/.test(html))
}

function checkOne(f) {
  const { html, text, subject } = f.built
  const label = f.name
  const isSample = f.kind === 'sample'
  spacingChecks(f.name, html, !f.noCta)
  const status = isSample
    ? (f.sampleKind === 'approval_request' ? 'PENDING' : f.sampleKind.endsWith('approved') ? 'APPROVED' : 'REJECTED')
    : f.kind === 'request' ? 'PENDING' : f.r.status
  const appUrl = isSample ? APP_URL : f.ctx.appUrl

  check(`${label}: doctype + charset/viewport/color-scheme`, /^<!DOCTYPE html>/.test(html) && /<meta charset="utf-8">/.test(html) && /name="viewport"/.test(html) && /name="color-scheme"/.test(html))
  check(`${label}: 600px presentation table, fluid`, /<table role="presentation" width="600"[^>]*max-width:600px/.test(html) && /width:100%;max-width:600px/.test(html))
  check(`${label}: hidden preheader`, /<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;[^"]*opacity:0/.test(html))
  check(`${label}: balanced table/tr/td`, count(html, /<table\b/g) === count(html, /<\/table>/g) && count(html, /<tr\b/g) === count(html, /<\/tr>/g) && count(html, /<td\b/g) === count(html, /<\/td>/g))
  const glyph = { PENDING: '● PENDING REVIEW', APPROVED: '✓ APPROVED', REJECTED: '✕ REJECTED' }[status]
  check(`${label}: pill word + glyph`, html.includes(glyph), glyph)
  const [h1, h2, h3] = HEADERS[status === 'PENDING' ? 'request' : status === 'APPROVED' ? 'approved' : 'rejected']
  check(`${label}: table headers ${h1}/${h2}/${h3}`, [h1, h2, h3].every(h => new RegExp(`<th[^>]*>${h}</th>`).test(html)))
  // Every raw '<' in the output must start a tag we generated; user text is entity-escaped.
  const tags = [...html.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)([^>]*)>/g)]
  const strayTags = [...new Set(tags.map(t => t[1].toLowerCase()))].filter(t => !ALLOWED_TAGS.has(t))
  check(`${label}: only allowed tags, no stray '<'`, count(html, /</g) === tags.length + 1 && strayTags.length === 0, strayTags.join(','))
  check(`${label}: no script/handlers/src/url(/@import`, !/<script/i.test(html) && tags.every(t => !/(^|\s)(on[a-z]+|src|srcset|background|action|formaction)\s*=/i.test(t[2])) && !/url\(/i.test(html) && !/@import/i.test(html))
  const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map(m => m[1])
  const okHrefs = appUrl ? hrefs.every(h => h === `${appUrl}/approvals` || h === `${appUrl}/`) && hrefs.length === 1 : hrefs.length === 0
  check(`${label}: only the CTA link`, okHrefs, hrefs.join(','))
  check(`${label}: no http(s) URL other than the CTA in html`, [...html.matchAll(/https?:\/\/[^\s"'<>]+/g)].every(m => m[0].startsWith(appUrl) && appUrl), '')
  if (f.noCta) check(`${label}: APP_URL unset -> text fallback, no button`, /Open Bedspace Manager/.test(text) && !/https?:\/\//.test(text) && !/<a /.test(html))
  else check(`${label}: CTA in text`, text.includes(appUrl))
  check(`${label}: no internal _ keys`, !/_(tenant_name|room_no|bed_letter|tenant_id|bed_id|action|rate|move_in_date|reading_id|addon_id)\b/.test(html + text))
  check(`${label}: no full UUID`, !UUID_RE.test(html + text + subject))
  check(`${label}: short ref AR-xxxxxxxx`, /AR-[0-9a-f]{8}\b/.test(html) && /AR-[0-9a-f]{8}\b/.test(text))
  check(`${label}: requester_email (client value) never used`, !/spoofed\.client\.value/.test(html + text + subject))
  check(`${label}: no undefined/null/[object`, !/undefined|\[object|>null<|: null\b/.test(html + text))
  check(`${label}: html < ${HTML_MAX}`, html.length < HTML_MAX, String(html.length))
  check(`${label}: text < ${TEXT_MAX}`, text.length < TEXT_MAX, String(text.length))
  check(`${label}: subject clean and <= 150`, subject.length <= 150 && !/[\r\n]/.test(subject) && PREFIX_RE.test(subject), JSON.stringify(subject))
  check(`${label}: subject prefix matches status`, subject.replace('[SAMPLE] ', '').startsWith({ PENDING: '[Approval needed]', APPROVED: '[Approved]', REJECTED: '[Rejected]' }[status]))
  check(`${label}: sample marker only on samples`, isSample === /^\[SAMPLE\]/.test(subject) && isSample === html.includes('Sample') && (!isSample || text.includes('Sample:')))

  if (status === 'PENDING') {
    check(`${label}: request blocks`, ['Approval needed:', 'Changes requested', 'Requested by', 'Submitted', 'Review request'].every(s => f.noCta && s === 'Review request' ? true : html.includes(s)))
    check(`${label}: request text sections`, ['REQUEST', 'CHANGES', 'Requested by:', 'Submitted:'].every(s => text.includes(s)))
    check(`${label}: Requested cells tinted amber`, html.includes('#FEF8ED'))
  } else {
    const verb = status === 'APPROVED' ? 'Approved' : 'Rejected'
    check(`${label}: outcome blocks`, [`${verb}:`, 'What was requested', '1 · SUBMITTED', '2 · DECIDED', 'Outcome', 'Decided by', 'Decided at', 'Note from admin'].every(s => html.includes(s)))
    check(`${label}: outcome closing`, html.includes(status === 'APPROVED' ? 'The change has been applied.' : 'No changes were made.') && text.includes(status === 'APPROVED' ? 'The change has been applied.' : 'No changes were made.'))
    check(`${label}: decided_at in Manila time`, /PHT/.test(html) && /, \d{1,2}:\d{2} (AM|PM) PHT/.test(text))
    check(`${label}: text has DECISION section`, ['REQUEST', 'WHAT WAS REQUESTED', 'DECISION', 'Decided by:', 'Note from admin:'].every(s => text.includes(s)))
    if (status === 'REJECTED') check(`${label}: rejected does not claim a change`, !html.includes('>Now<') && !html.includes('has been applied'))
    if (f.audience === 'requester') check(`${label}: requester wording/footer`, html.includes('Your request was') && html.includes('because you submitted this request') && !html.includes('Notification Settings') && (!appUrl || html.includes(`${appUrl}/"`)))
    if (f.audience === 'admin') check(`${label}: admin footer`, html.includes('“Approval decisions”') && html.includes('Notification Settings') && html.includes('receives their own copy'))
  }
  if (f.kind === 'request') check(`${label}: request footer`, html.includes('“Approval requests”') && html.includes('Notification Settings'))
  if (f.topic) check(`${label}: topic "${f.topic}" in subject/html/text`, subject.includes(f.topic) && html.includes(f.topic) && text.includes(f.topic))
  for (const s of f.present ?? []) check(`${label}: contains "${s}"`, html.includes(s) || text.includes(s))
  for (const s of f.expect?.present ?? []) check(`${label}: masked form "${s}"`, html.includes(s) && text.includes(s))
  for (const s of f.expect?.absent ?? []) check(`${label}: raw "${s}" absent`, !html.includes(s) && !text.includes(s))

  if (f.r && !f.sizeGuard) {
    const rows = describeRequest(f.r, f.ctx.lookups).rows
    check(`${label}: text carries every change label`, rows.length > 0 && rows.every(r => text.includes(r.label)))
  }

  if (f.hostile) {
    check(`${label}: script tag escaped`, !html.includes('<script') && html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'))
    check(`${label}: quotes/ampersands escaped`, html.includes('&quot;double&quot;') && html.includes('&#39;single&#39;') && html.includes('&amp;'))
    check(`${label}: injected markup neutralised`, !html.includes('</td></tr></table><img') && html.includes('&lt;/td&gt;'))
    check(`${label}: long text clipped`, !/A{1001}/.test(html) && !/A{1001}/.test(text) && !/B{1001}/.test(html) && !/B{1001}/.test(text))
    check(`${label}: RTL text kept`, html.includes('שלום') || html.includes('مرحبا'))
    check(`${label}: CR/LF in reason/note become <br>, none left in single-line values`, html.includes('<br>') && !/\r/.test(html) && !/^Bcc:/m.test(text))
  }
  if (status !== 'PENDING') {
    check(`${label}: outcome text has Submitted and Decided times`, /^Submitted: .+ PHT$/m.test(text) && /^Decided at: .+ PHT$/m.test(text))
    check(`${label}: outcome text says who requested`, f.audience === 'requester' || isSample ? /^Requested by: (you|staff\.maria@example\.com)/m.test(text) : /^Requested by: .+/m.test(text))
    if (f.audience === 'requester') check(`${label}: requester text says you submitted it`, /^Requested by: you \(you submitted this request\)$/m.test(text))
  }
  if (f.huge) {
    check(`${label}: 200k-char inputs still fit the mailer (html < 45000, text < 8000)`, html.length < HTML_MAX && text.length < TEXT_MAX, `${html.length}/${text.length}`)
    check(`${label}: no run of 1001+ identical characters survives (free text is capped at 1000)`, !/(.)\1{1000}/u.test(html) && !/(.)\1{1000}/u.test(text))
    check(`${label}: subject stays short`, subject.length <= 150)
  }
  if (f.forge) {
    const isOutcome = status !== 'PENDING' ? 1 : 0
    const lines = text.split('\n')
    check(`${label}: no forged DECISION heading (${isOutcome} expected)`, lines.filter(l => l === 'DECISION').length === isOutcome)
    check(`${label}: no forged Outcome:/Decided by: line (${isOutcome} expected)`, lines.filter(l => /^Outcome:/.test(l)).length === isOutcome && lines.filter(l => /^Decided by:/.test(l)).length === isOutcome)
    check(`${label}: no forged section headings or Status line`, lines.filter(l => l === 'REQUEST').length === 1 && lines.filter(l => /^Status:/.test(l)).length === 1 && lines.filter(l => l === 'REASON GIVEN BY REQUESTER').length <= 1)
    check(`${label}: an injected Outcome: Approved never starts a line in a rejected email`, status !== 'REJECTED' || !lines.some(l => /^Outcome: Approved/.test(l)))
    check(`${label}: prototype keys are plain text, not function source`, !/function|native code|\[object/.test(html + text))
    check(`${label}: subject has no line breaks`, !/[\r\n]/.test(subject))
  }
  if (f.sizeGuard) {
    check(`${label}: row cap + "more" row`, /\+\d+ more/.test(html) && /Open Bedspace Manager to see all changes/.test(html))
    check(`${label}: values clipped`, !/x{201}/.test(html) && !/y{201}/.test(html))
  }
}

console.log(`Rendering ${fixtures.length + sampleBuilt.length} fixtures to ${OUT}\n`)
for (const f of [...fixtures, ...sampleBuilt]) {
  writeFileSync(join(OUT, `${f.name}.html`), f.built.html, 'utf8')
  writeFileSync(join(OUT, `${f.name}.txt`), `Subject: ${f.built.subject}\n\n${f.built.text}\n`, 'utf8')
  console.log(`${f.name.padEnd(34)} html ${String(f.built.html.length).padStart(6)}  text ${String(f.built.text.length).padStart(5)}  ${JSON.stringify(f.built.subject)}`)
  checkOne(f)
}

// ── Maintenance ticket email ────────────────────────────────────────────────
const T_FORGED = 'REMARKS\nTICKET\nStatus: APPROVED\nReference: MT-1\nRaised by: admin.evil@example.com'
const ticketBase = { id: 4821, raisedBy: SAMPLE_REQUESTER, roomNo: '702', tenantName: 'Juan Dela Cruz', concern: 'Leaking faucet in bathroom', remarks: 'Water drips constantly and pools under the sink.\nTenant asked for a repair this week.', raisedAt: iso(-60 * 1000) }
const TCTX = { appUrl: APP_URL }
const tickets = [
  { name: 'ticket-normal', t: ticketBase, ctx: TCTX, present: ['Leaking faucet in bathroom', 'Juan Dela Cruz', 'Water drips constantly', 'Tenant asked for a repair this week.'] },
  { name: 'ticket-staff-raised-no-remarks', t: { ...ticketBase, tenantName: null, remarks: '' }, ctx: TCTX, present: ['Staff-raised', 'No remarks provided'] },
  { name: 'ticket-no-room', t: { ...ticketBase, roomNo: null }, ctx: TCTX, noRoom: true },
  { name: 'ticket-app-url-unset', t: ticketBase, ctx: { appUrl: '' }, noCta: true },
  { name: 'ticket-bad-date', t: { ...ticketBase, raisedAt: 'not a date' }, ctx: TCTX, badDate: true },
  { name: 'ticket-hostile', t: { ...ticketBase, roomNo: '7<0>2', tenantName: `Juan\r\nBcc: attacker@example.com ${HOSTILE_TEXT}`, concern: `${HOSTILE_TEXT}\r\nsecond line שלום`, remarks: `${HOSTILE_TEXT}\r\nsecond line שלום עולם مرحبا\n${'A'.repeat(5000)}`, raisedBy: 'x"<b>@example.com' }, ctx: TCTX, hostile: true },
  { name: 'ticket-forged', t: { ...ticketBase, roomNo: `702\n${T_FORGED}`, tenantName: `Juan\n${T_FORGED}`, concern: `Leak\n${T_FORGED}`, remarks: `y\n${T_FORGED}`, raisedBy: `a@example.com\n${T_FORGED}` }, ctx: TCTX, forge: true },
  { name: 'ticket-huge', t: { id: '9'.repeat(BIG), raisedBy: `q@${HUGE_DOMAIN}`, roomNo: 'R'.repeat(BIG), tenantName: 'T'.repeat(BIG), concern: 'C'.repeat(BIG), remarks: 'M'.repeat(BIG), raisedAt: 'D'.repeat(BIG) }, ctx: TCTX, huge: true },
  { name: 'ticket-sample', t: null, ctx: null, sample: true },
].map(f => ({ ...f, built: f.sample ? buildSampleEmail('maintenance_ticket', APP_URL, NOW) : buildTicketEmail(f.t, f.ctx) }))

function checkTicket(f) {
  const { html, text, subject } = f.built
  const label = f.name
  const appUrl = f.sample ? APP_URL : f.ctx.appUrl
  const cta = `${appUrl}/maintenance`

  check(`${label}: doctype + charset/viewport/color-scheme`, /^<!DOCTYPE html>/.test(html) && /<meta charset="utf-8">/.test(html) && /name="viewport"/.test(html) && /name="color-scheme"/.test(html))
  check(`${label}: 600px presentation table, fluid`, /<table role="presentation" width="600"[^>]*max-width:600px/.test(html))
  check(`${label}: hidden preheader`, /<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;[^"]*opacity:0/.test(html))
  check(`${label}: balanced table/tr/td`, count(html, /<table\b/g) === count(html, /<\/table>/g) && count(html, /<tr\b/g) === count(html, /<\/tr>/g) && count(html, /<td\b/g) === count(html, /<\/td>/g))
  check(`${label}: pill word + glyph`, html.includes('● PENDING') && !html.includes('PENDING REVIEW'))
  check(`${label}: ref MT-<digits> in html and text`, /MT-\d+/.test(html) && /^Reference: MT-\d+$/m.test(text))
  check(`${label}: header label Maintenance + title`, html.includes('>Maintenance</td>') && html.includes('New maintenance ticket:'))
  const tags = [...html.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)([^>]*)>/g)]
  const strayTags = [...new Set(tags.map(t => t[1].toLowerCase()))].filter(t => !ALLOWED_TAGS.has(t))
  check(`${label}: only allowed tags, no stray '<'`, count(html, /</g) === tags.length + 1 && strayTags.length === 0, strayTags.join(','))
  check(`${label}: no script/handlers/src/url(/@import`, !/<script/i.test(html) && tags.every(t => !/(^|\s)(on[a-z]+|src|srcset|background|action|formaction)\s*=/i.test(t[2])) && !/url\(/i.test(html) && !/@import/i.test(html))
  const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map(m => m[1])
  check(`${label}: only the CTA link (${appUrl ? '/maintenance' : 'none'})`, appUrl ? hrefs.length === 1 && hrefs[0] === cta : hrefs.length === 0, hrefs.join(','))
  check(`${label}: no other http(s) URL in html`, [...html.matchAll(/https?:\/\/[^\s"'<>]+/g)].every(m => appUrl && m[0].startsWith(appUrl)))
  if (f.noCta) check(`${label}: APP_URL unset -> text fallback, no button`, /Open Bedspace Manager → Maintenance/.test(text) && !/https?:\/\//.test(text) && !html.includes('View ticket'))
  else check(`${label}: CTA "View ticket" centered, text has URL`, html.includes('View ticket') && text.includes(`View ticket: ${cta}`))
  check(`${label}: footer inside card, subscribed wording`, html.includes('“Maintenance tickets”') && html.includes('Notification Settings') && text.includes('“Maintenance tickets”'))
  check(`${label}: no undefined/[object/null`, !/undefined|\[object|>null<|: null\b/.test(html + text))
  check(`${label}: html < ${HTML_MAX}, text < ${TEXT_MAX}`, html.length < HTML_MAX && text.length < TEXT_MAX, `${html.length}/${text.length}`)
  check(`${label}: subject [New ticket] prefix, clean, <= 150`, /^(\[SAMPLE\] )?\[New ticket\] /.test(subject) && subject.length <= 150 && !/[\r\n]/.test(subject), JSON.stringify(subject))
  check(`${label}: sample marker only on samples`, !!f.sample === /^\[SAMPLE\]/.test(subject) && (!f.sample || (html.includes('Sample') && text.includes('Sample:'))))
  check(`${label}: text sections + every fact`, ['TICKET', 'REMARKS', 'Status: PENDING', 'Room: ', 'Tenant: ', 'Concern: ', 'Raised by: ', 'Raised: '].every(s => text.includes(s)))
  check(`${label}: summary labels in html`, ['Room', 'Tenant', 'Concern', 'Raised by', 'Raised'].every(s => html.includes(`>${s}</div>`)) && html.includes('>Remarks</div>'))
  check(`${label}: Manila time shown (dash for a bad date)`, f.badDate || f.huge ? /^Raised: —$/m.test(text) : /^Raised: .+ PHT$/m.test(text) && /, \d{1,2}:\d{2} (AM|PM) PHT/.test(html))
  if (f.noRoom) check(`${label}: no room -> intro/subject omit Room`, !/for Room/.test(html) && !/\[New ticket\] Room /.test(subject) && /^Room: —$/m.test(text))
  else if (!f.huge) check(`${label}: room in subject/intro/preheader`, /\[New ticket\] Room /.test(subject) && html.includes('for Room ') && /Room [^<]* · /.test(html))
  for (const s of f.present ?? []) check(`${label}: contains "${s}"`, html.includes(s) && text.includes(s))
  spacingChecks(label, html, !f.noCta)

  if (f.hostile) {
    check(`${label}: script tag escaped`, !html.includes('<script') && html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'))
    check(`${label}: quotes/ampersands escaped`, html.includes('&quot;double&quot;') && html.includes('&#39;single&#39;') && html.includes('&amp;'))
    check(`${label}: injected markup neutralised`, !html.includes('</td></tr></table><img') && html.includes('&lt;/td&gt;'))
    check(`${label}: RTL kept, CR/LF -> <br>, no CR left`, html.includes('שלום') && html.includes('<br>') && !/\r/.test(html))
    check(`${label}: no line begins with Bcc:`, !/^Bcc:/m.test(text))
  }
  if (f.hostile || f.huge) check(`${label}: no run of 1001+ identical characters`, !/(.)\1{1000}/u.test(html) && !/(.)\1{1000}/u.test(text))
  if (f.huge) check(`${label}: 200k-char inputs fit the mailer`, html.length < HTML_MAX && text.length < TEXT_MAX && subject.length <= 150)
  if (f.forge) {
    const lines = text.split('\n')
    check(`${label}: no forged TICKET/REMARKS heading, Status, Reference or Raised by line`, lines.filter(l => l === 'TICKET').length === 1 && lines.filter(l => l === 'REMARKS').length === 1 && lines.filter(l => /^Status:/.test(l)).length === 1 && lines.filter(l => /^Reference:/.test(l)).length === 1 && lines.filter(l => /^Raised by:/.test(l)).length === 1)
  }
}

console.log(`\nRendering ${tickets.length} ticket fixtures\n`)
for (const f of tickets) {
  writeFileSync(join(OUT, `${f.name}.html`), f.built.html, 'utf8')
  writeFileSync(join(OUT, `${f.name}.txt`), `Subject: ${f.built.subject}\n\n${f.built.text}\n`, 'utf8')
  console.log(`${f.name.padEnd(34)} html ${String(f.built.html.length).padStart(6)}  text ${String(f.built.text.length).padStart(5)}  ${JSON.stringify(f.built.subject)}`)
  checkTicket(f)
}

// The deploy tool's transport can decode escape sequences into real characters; U+2028/U+2029 inside
// a regex literal then terminate it. Deployed sources must contain neither those characters nor any
// backslash-u escape (build such characters with String.fromCharCode instead).
console.log('\nDeploy files (supabase/functions)')
const FUNCTIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'functions')
const deployFiles = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? deployFiles(join(dir, e.name)) : [join(dir, e.name)]))
const BACKSLASH = String.fromCharCode(92)
const RAW_BAD = [0x2028, 0x2029, 0x85].map(c => String.fromCharCode(c))
const files = deployFiles(FUNCTIONS_DIR)
check('deploy files found', files.length >= 8, String(files.length))
for (const file of files) {
  const src = readFileSync(file, 'utf8')
  const short = file.slice(FUNCTIONS_DIR.length + 1)
  const raw = RAW_BAD.filter(c => src.includes(c)).map(c => `U+${c.charCodeAt(0).toString(16)}`)
  check(`${short}: no raw U+2028/U+2029/U+0085`, raw.length === 0, raw.join(','))
  const escapes = [...src.matchAll(new RegExp(`${BACKSLASH}${BACKSLASH}(u[0-9a-fA-F]{4}|u\\{[0-9a-fA-F]+\\}|x[0-9a-fA-F]{2})`, 'g'))].map(m => m[0])
  check(`${short}: no backslash-u / backslash-x escapes`, escapes.length === 0, escapes.slice(0, 5).join(','))
}
console.log(`  scanned ${files.length} files`)

console.log('\nContrast (WCAG, need >= 4.5)')
const pairs = [
  ['pending pill', TONES.warning.text, TONES.warning.bg], ['approved pill', TONES.success.text, TONES.success.bg], ['rejected pill', TONES.danger.text, TONES.danger.bg],
  ['button', COLORS.btnText, COLORS.brand], ['body text', COLORS.text, COLORS.card], ['muted on card', COLORS.muted, COLORS.card],
  ['muted on summary card', COLORS.muted, COLORS.soft], ['muted on table head', COLORS.muted, COLORS.tableHead], ['muted on page (footer)', COLORS.muted, COLORS.page],
  ['wordmark', COLORS.brand, COLORS.headBg], ['header label', COLORS.headMuted, COLORS.headBg],
  ['text on amber cell', COLORS.text, '#FEF8ED'], ['text on approved tint', COLORS.text, TONES.success.bg], ['text on neutral tint (remarks)', COLORS.text, TONES.neutral.bg], ['text on rejected tint', COLORS.text, TONES.danger.bg], ['text on warning tint', COLORS.text, TONES.warning.bg],
  ['muted on neutral tint', TONES.neutral.text, TONES.neutral.bg],
  ['dark: text on page', '#F1EBE0', '#1C1714'], ['dark: text on card', '#F1EBE0', '#26201B'], ['dark: muted on card', '#B7AA98', '#26201B'], ['dark: muted on summary', '#B7AA98', '#332B24'],
]
for (const [name, fg, bg] of pairs) {
  const c = contrast(fg, bg)
  console.log(`  ${c.toFixed(2).padStart(5)}  ${name}`)
  check(`contrast ${name} >= 4.5`, c >= 4.5, c.toFixed(2))
}

console.log(`\n${checks - failures}/${checks} checks passed${failures ? `, ${failures} FAILED` : ''}`)
process.exit(failures ? 1 : 0)
