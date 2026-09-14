import {
  supabase, fetchTenantContacts, fetchTenantEmails,
  addTenantContact, updateTenantContact, deleteTenantContact, setPrimaryContact,
  addTenantEmail, updateTenantEmail, deleteTenantEmail, setPrimaryEmail,
  logTenantProfileEdit, logTenantMoveOutDateChange, PROFILE_FIELD_LABELS,
} from './supabase'

export { PROFILE_FIELD_LABELS }
export const PROFILE_FIELDS = Object.keys(PROFILE_FIELD_LABELS)

const CONTACT_API = { add: addTenantContact, update: updateTenantContact, del: deleteTenantContact, setPrimary: setPrimaryContact }
const EMAIL_API   = { add: addTenantEmail,   update: updateTenantEmail,   del: deleteTenantEmail,   setPrimary: setPrimaryEmail }

export function norm(v) {
  const s = v == null ? '' : String(v).trim()
  return s === '' ? null : s
}

export function entriesFromDb(rows) {
  return rows.map(r => ({ id: r.id, value: r.value ?? '', label: r.label ?? '', isPrimary: !!r.is_primary }))
}

export function diffEntries(origRows, rows) {
  const clean = rows
    .map(r => ({ ...r, value: (r.value || '').trim(), label: norm(r.label) }))
    .filter(r => r.value)
  const keptIds = new Set(clean.filter(r => r.id != null).map(r => r.id))
  const removed = origRows.filter(o => !keptIds.has(o.id))
  const added   = clean.filter(r => r.id == null)
  const updated = clean
    .filter(r => r.id != null)
    .map(r => ({ row: r, orig: origRows.find(o => o.id === r.id) }))
    .filter(({ row, orig }) => orig && (row.value !== orig.value.trim() || row.label !== norm(orig.label)))
  const primary        = clean.find(r => r.isPrimary) || clean[0] || null
  const origPrimary    = origRows.find(o => o.isPrimary) || null
  const primaryChanged = !!primary && (primary.id == null || primary.id !== origPrimary?.id)
  return {
    clean, removed, added, updated, primary, origPrimary, primaryChanged,
    changed: removed.length > 0 || added.length > 0 || updated.length > 0 || primaryChanged,
  }
}

function emptyDone() { return { added: [], removed: [], updated: [], primary: null } }
function hasDone(d)  { return d.added.length > 0 || d.removed.length > 0 || d.updated.length > 0 || !!d.primary }

// Records each write into `done` as it succeeds, so a mid-way failure still
// logs exactly what reached the DB. Deletes run last so a failed insert can't
// leave the tenant with no contacts.
export async function applyEntries(tenantId, d, api, done) {
  const newIds = new Map()
  for (const r of d.added) {
    const row = await api.add(tenantId, { value: r.value, label: r.label, isPrimary: false })
    newIds.set(r, row.id)
    done.added.push(r.value)
  }
  for (const { row, orig } of d.updated) {
    await api.update(row.id, { value: row.value, label: row.label })
    const labelChanged = row.label !== norm(orig.label)
    done.updated.push({
      old: orig.value, new: row.value,
      ...(labelChanged ? { old_label: norm(orig.label), new_label: row.label } : {}),
    })
  }
  if (d.primaryChanged) {
    await api.setPrimary(tenantId, d.primary.id ?? newIds.get(d.primary))
    done.primary = { old: d.origPrimary?.value ?? null, new: d.primary.value }
  }
  for (const o of d.removed) {
    await api.del(o.id)
    done.removed.push(o.value)
  }
}

// The requested list may predate the current rows (approval queued for days, or
// re-approved after a partial failure). Ids that no longer exist are re-added,
// and new entries whose value already exists on an unreferenced row reuse that
// row, so applying the same request twice never duplicates entries.
function alignToCurrent(current, requested) {
  const currentIds = new Set(current.map(c => c.id))
  const claimed = new Set(requested.filter(r => r.id != null && currentIds.has(r.id)).map(r => r.id))
  return requested.map(r => {
    if (r.id != null && currentIds.has(r.id)) return r
    const value = (r.value || '').trim()
    const match = current.find(c => !claimed.has(c.id) && c.value.trim() === value)
    if (match) {
      claimed.add(match.id)
      return { ...r, id: match.id }
    }
    return { ...r, id: null }
  })
}

async function reconcile(tenantId, requested, fetchCurrent, api, done) {
  const current = entriesFromDb(await fetchCurrent(tenantId))
  const d = diffEntries(current, alignToCurrent(current, requested))
  if (d.changed) await applyEntries(tenantId, d, api, done)
}

/**
 * Applies a profile change set to `tenant` (the current DB row, with room_no /
 * bed_letter for logging). `fields` = { column: newValue } for PROFILE_FIELDS;
 * `moveOutDate` undefined = untouched; `contacts` / `emails` = requested final
 * list or null = untouched. Never throws — returns what happened so callers can
 * report partial saves.
 */
export async function applyTenantProfileChange(tenant, { fields = {}, moveOutDate, contacts = null, emails = null }) {
  const bad = Object.keys(fields).find(k => !PROFILE_FIELDS.includes(k))
  if (bad) return { wrote: false, saveError: `Field "${bad}" can't be changed from the tenant profile.`, logError: null }
  if (contacts && !contacts.some(r => (r.value || '').trim())) {
    return { wrote: false, saveError: 'At least one contact number is required.', logError: null }
  }

  const fieldChanges = {}
  for (const [k, v] of Object.entries(fields)) {
    const o = norm(tenant[k])
    const n = norm(v)
    if (o !== n) fieldChanges[k] = { old: o, new: n }
  }
  const newMoveOut     = moveOutDate === undefined ? undefined : (moveOutDate || null)
  const moveOutChanged = newMoveOut !== undefined && newMoveOut !== (tenant.move_out_date?.slice(0, 10) || null)

  const doneFields = {}
  const doneC = emptyDone()
  const doneE = emptyDone()
  let moveOutWritten = false
  let saveError = null

  try {
    const patch = Object.fromEntries(Object.entries(fieldChanges).map(([k, c]) => [k, c.new]))
    if (moveOutChanged) patch.move_out_date = newMoveOut
    if (Object.keys(patch).length) {
      const { error } = await supabase.from('tenants').update(patch).eq('id', tenant.id)
      if (error) throw error
      Object.assign(doneFields, fieldChanges)
      moveOutWritten = moveOutChanged
    }
    if (contacts) await reconcile(tenant.id, contacts, fetchTenantContacts, CONTACT_API, doneC)
    if (emails)   await reconcile(tenant.id, emails,   fetchTenantEmails,   EMAIL_API,   doneE)
  } catch (err) {
    saveError = err.message
  }

  const profileWritten = Object.keys(doneFields).length > 0 || hasDone(doneC) || hasDone(doneE)
  const logTenant = { ...tenant, name: doneFields.name ? doneFields.name.new : tenant.name }

  let logError = null
  if (profileWritten) {
    try {
      await logTenantProfileEdit(logTenant, {
        fields:   doneFields,
        contacts: hasDone(doneC) ? doneC : null,
        emails:   hasDone(doneE) ? doneE : null,
      })
    } catch (err) {
      logError = err.message
    }
  }
  if (moveOutWritten) await logTenantMoveOutDateChange(logTenant, newMoveOut)

  return { wrote: profileWritten || moveOutWritten, saveError, logError }
}
