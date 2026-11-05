import { useState, useEffect } from 'react'
import {
  addTenant, addTenantDocument, fetchReservationPayments, fetchAllReservationPayments,
  recordMoveInReceipts, assertMoveInReceiptsAvailable, supabase,
} from '../lib/supabase'
import { dbToCents } from '../lib/receiptLines'
import { getOrCreateTenantFolder, uploadFileToDrive, isDriveConfigured } from '../lib/googleDrive'
import MoveInModal from './MoveInModal'

// The one Move In path (Tenants page and Bed Map): reservation money, receipts RPC, contacts, emails, documents.
// Without allBeds the bed is locked. Toasts go through the parent's `show` because this unmounts on success.
export default function MoveInFlow({ bed, allBeds, onBedChange, onClose, onDone, show }) {
  const [saving,    setSaving]    = useState(false)
  const [resPayments, setResPayments] = useState([])
  const [resLoading,  setResLoading]  = useState(false)
  const [resError,    setResError]    = useState('')
  const [otherReserved, setOtherReserved] = useState([])

  // HELD reservation money belongs to the selected bed; re-fetched whenever another bed is picked.
  const moveInBedId = bed?.bed_id ?? null
  const moveInReserved = bed?.status === 'RESERVED'
  useEffect(() => {
    setResPayments([]); setResError('')
    if (moveInBedId == null || !moveInReserved) { setResLoading(false); return }
    let cancelled = false
    setResLoading(true)
    fetchReservationPayments({ bedId: moveInBedId, statuses: ['HELD'] })
      .then(rows => { if (!cancelled) setResPayments(rows) })
      .catch(e => { if (!cancelled) setResError(e.message) })
      .finally(() => { if (!cancelled) setResLoading(false) })
    return () => { cancelled = true }
  }, [moveInBedId, moveInReserved])

  // For the "name matches a different reserved bed that holds money" warning; best-effort.
  const moveInOpen = moveInBedId != null
  useEffect(() => {
    if (!moveInOpen) { setOtherReserved([]); return }
    let cancelled = false
    fetchAllReservationPayments({ statuses: ['HELD'] })
      .then(rows => {
        if (cancelled) return
        const byBed = new Map()
        for (const r of rows) {
          const cur = byBed.get(r.bed_id) || {
            bed_id: r.bed_id, reserved_name: r.reserved_name,
            room_no: r.beds?.rooms?.room_no, bed_letter: r.beds?.bed_letter, totalCents: 0,
          }
          cur.totalCents += dbToCents(r.amount)
          byBed.set(r.bed_id, cur)
        }
        setOtherReserved([...byBed.values()])
      })
      .catch(() => { if (!cancelled) setOtherReserved([]) })
    return () => { cancelled = true }
  }, [moveInOpen])

  async function handleMoveIn(data) {
    if (!bed) return
    setSaving(true)
    try {
      const { contacts = [], emails = [], docs = [], receipts, ...tenantData } = data
      // Stops BEFORE the tenant is created if the receipts RPC is not deployed yet.
      await assertMoveInReceiptsAvailable()
      const tenant = await addTenant(bed.bed_id, {
        ...tenantData,
        _room_no:    bed.room_no,
        _bed_letter: bed.bed_letter,
      })

      let depositError = null
      try {
        await recordMoveInReceipts(tenant.id, receipts)
      } catch(depErr) {
        depositError = depErr
      }

      const validContacts = contacts.filter(c => c.value.trim())
      if (validContacts.length) {
        await supabase.from('tenant_contacts').insert(
          validContacts.map((c, i) => ({
            tenant_id:  tenant.id,
            value:      c.value.trim(),
            label:      c.label?.trim() || null,
            is_primary: c.isPrimary || i === 0,
          }))
        )
      }

      const validEmails = emails.filter(e => e.value.trim())
      if (validEmails.length) {
        await supabase.from('tenant_emails').insert(
          validEmails.map((e, i) => ({
            tenant_id:  tenant.id,
            value:      e.value.trim(),
            label:      e.label?.trim() || null,
            is_primary: e.isPrimary || i === 0,
          }))
        )
      }

      const validDocs = docs.filter(d => d.file)
      if (validDocs.length) {
        if (!isDriveConfigured()) {
          show('Documents skipped — Google Drive not configured. Upload via tenant profile later.', 'error')
        } else {
          try {
            const folderId = await getOrCreateTenantFolder(tenant.name, bed.room_no)
            for (const d of validDocs) {
              const driveFile = await uploadFileToDrive(d.file, folderId)
              await addTenantDocument(tenant.id, {
                docType:     d.docType,
                filename:    d.file.name,
                driveFileId: driveFile.id,
                driveUrl:    driveFile.webViewLink,
                sizeBytes:   d.file.size || null,
              })
            }
          } catch(driveErr) {
            show(`Documents not uploaded: ${driveErr.message}. Upload via tenant profile later.`, 'error')
          }
        }
      }

      onClose()
      if (depositError) {
        show(`${tenant.name} was moved in, but the advance/deposit was NOT recorded: ${depositError.message}. An admin can add them from the tenant profile (Advance & Deposit tab). If this bed already had a reservation payment recorded, do not retype it: open the tenant's Advance & Deposit tab and use Apply reservation payment. Any reservation payment lines typed in Move In were NOT saved either; an admin can add them as Deposit receipts from that tab.`, 'error', { duration: 20000 })
      } else {
        show('Tenant moved in!', 'success')
      }
      onDone()
    } catch(e) { show(e.message, 'error') }
    setSaving(false)
  }

  if (!bed) return null
  return (
    <MoveInModal
      bed={bed}
      allBeds={allBeds}
      onBedChange={onBedChange}
      onClose={onClose}
      onSubmit={handleMoveIn}
      saving={saving}
      reservationPayments={resPayments}
      reservationLoading={resLoading}
      reservationError={resError}
      otherReservedWithMoney={otherReserved}
    />
  )
}
