import { useState, useEffect, useMemo } from 'react'
import { fetchBeds, fetchTenants, addTenant, processMoveOut, recordPayment, fetchPayments } from '../lib/supabase'
import { useToast } from '../components/Toast'
import MoveInModal  from '../components/MoveInModal'
import MoveOutModal from '../components/MoveOutModal'

const PAGE = 20

function badgeClass(s) {
  switch ((s||'').toUpperCase()) {
    case 'LEASED':       return 'leased'
    case 'RESERVED':     return 'reserved'
    case 'OUT OF ORDER': return 'oor'
    default:             return 'vacant'
  }
}
function fmt(n) { return n ? '₱' + Number(n).toLocaleString('en-PH') : '—' }
function fmtDate(d) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('en-PH', { month:'short', day:'numeric', year:'numeric' })
}

export default function Tenants() {
  const [beds,      setBeds]      = useState([])
  const [tenants,   setTenants]   = useState([])
  const [loading,   setLoading]   = useState(true)
  const [search,    setSearch]    = useState('')
  const [statFilter,setStatFilter]= useState('LEASED')
  const [roomFilter,setRoomFilter]= useState('')
  const [page,      setPage]      = useState(0)
  const [sortKey,   setSortKey]   = useState('room')   // default: Room No
  const [sortDir,   setSortDir]   = useState('asc')    // default: ascending
  const [detail,    setDetail]    = useState(null)  // tenant detail modal
  const [detailPays,setDetailPays]= useState([])
  const [moveInBed, setMoveInBed] = useState(null)
  const [moveOutT,  setMoveOutT]  = useState(null)  // tenant for move-out
  const [payModal,  setPayModal]  = useState(null)  // tenant for payment
  const [payType,   setPayType]   = useState('10th')
  const [payDate,   setPayDate]   = useState(today())
  const [saving,    setSaving]    = useState(false)
  const { show, ToastEl } = useToast()

  function today() { return new Date().toISOString().slice(0,10) }

  async function load() {
    setLoading(true)
    try {
      const [b, t] = await Promise.all([fetchBeds(), fetchTenants()])
      setBeds(b); setTenants(t)
    } catch(e) { show(e.message, 'error') }
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  const rooms = useMemo(() =>
    [...new Set(beds.map(b => b.room_no).filter(Boolean))].sort((a,b) => parseInt(a)-parseInt(b)),
  [beds])

  // Active tenants enriched with bed/room info
  const enriched = useMemo(() =>
    tenants.filter(t => t.is_active).map(t => ({
      ...t,
      room_no:   t.beds?.rooms?.room_no    || '',
      room_type: t.beds?.rooms?.room_type  || '',
      bed_letter:t.beds?.bed_letter        || '',
      bed_location: t.beds?.bed_location   || '',
    })),
  [tenants])

  const filtered = useMemo(() => {
    const q = search.toLowerCase()
    return enriched.filter(t => {
      if (statFilter && statFilter !== 'ALL' && t.is_active !== (statFilter === 'LEASED')) return false
      if (roomFilter && t.room_no !== roomFilter) return false
      if (q && !(t.name||'').toLowerCase().includes(q)
           && !(t.room_no||'').includes(q)
           && !(t.bed_letter||'').toLowerCase().includes(q)) return false
      return true
    })
  }, [enriched, search, statFilter, roomFilter])

  // ── Sorting ─────────────────────────────────────────────────────────────────
  const sorted = useMemo(() => {
    const val = (t, key) => {
      switch (key) {
        case 'name':    return (t.name || '').toLowerCase()
        case 'room':    return parseInt(t.room_no) || 0
        case 'bed':     return (t.bed_letter || '')
        case 'rate':    return Number(t.rate) || 0
        case 'movein':  return t.move_in_date  || ''
        case 'moveout': return t.move_out_date || ''
        default:        return ''
      }
    }
    const cmp = (a, b) => {
      const av = val(a, sortKey), bv = val(b, sortKey)
      let c = av < bv ? -1 : av > bv ? 1 : 0
      if (c !== 0) return sortDir === 'asc' ? c : -c
      // Tiebreaker: always Room No then Bed ascending (stable, predictable)
      const ra = parseInt(a.room_no) || 0, rb = parseInt(b.room_no) || 0
      if (ra !== rb) return ra - rb
      return (a.bed_letter || '').localeCompare(b.bed_letter || '')
    }
    return [...filtered].sort(cmp)
  }, [filtered, sortKey, sortDir])

  function handleSort(key) {
    if (key === sortKey) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir('asc')
    }
    setPage(0)
  }

  // Arrow indicator for a header
  const arrow = (key) =>
    key === sortKey ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''

  const pageRows = sorted.slice(page * PAGE, (page + 1) * PAGE)
  const totalPages = Math.ceil(sorted.length / PAGE)

  async function openDetail(t) {
    setDetail(t)
    try { setDetailPays(await fetchPayments(t.id)) }
    catch(e) { setDetailPays([]) }
  }

  async function handleMoveIn(data) {
    if (!moveInBed) return
    setSaving(true)
    try {
      await addTenant(moveInBed.bed_id, {
        ...data,
        _room_no:    moveInBed.room_no,
        _bed_letter: moveInBed.bed_letter,
      })
      setMoveInBed(null)
      show('Tenant moved in!', 'success')
      load()
    } catch(e) { show(e.message, 'error') }
    setSaving(false)
  }

  async function handleMoveOut(data) {
    if (!moveOutT) return
    setSaving(true)
    try {
      await processMoveOut(
        { ...moveOutT, _room_no: moveOutT.room_no, _bed_letter: moveOutT.bed_letter },
        data
      )
      setMoveOutT(null)
      show('Move-out processed.', 'success')
      load()
    } catch(e) { show(e.message, 'error') }
    setSaving(false)
  }

  async function handlePayment() {
    if (!payModal) return
    setSaving(true)
    try {
      await recordPayment(payModal.id, { payment_date: payDate, pay_type: payType, amount: payModal.rate })
      setPayModal(null)
      show('Payment recorded.', 'success')
      load()
    } catch(e) { show(e.message, 'error') }
    setSaving(false)
  }

  if (loading) return (
    <div className="loading-screen">
      <div className="spinner" />
      <span style={{ color:'#1B3A8C', fontWeight:600 }}>Loading…</span>
    </div>
  )

  return (
    <div className="page">
      <div className="page-title">Tenants</div>

      <div className="toolbar">
        <input
          type="search" placeholder="Search name, room, bed…"
          value={search} onChange={e => { setSearch(e.target.value); setPage(0) }}
        />
        <select value={statFilter} onChange={e => { setStatFilter(e.target.value); setPage(0) }}>
          <option value="LEASED">Active (Leased)</option>
          <option value="ALL">All Tenants</option>
        </select>
        <select value={roomFilter} onChange={e => { setRoomFilter(e.target.value); setPage(0) }}>
          <option value="">All Rooms</option>
          {rooms.map(r => <option key={r} value={r}>Room {r}</option>)}
        </select>
        <button className="btn primary" style={{ marginLeft:'auto' }}
          onClick={() => {
            // open move-in with room selection — pick first vacant bed
            const vacant = beds.find(b => b.status === 'VACANT' && (!roomFilter || b.room_no === roomFilter))
            if (vacant) setMoveInBed(vacant)
            else show('No vacant beds available.', 'error')
          }}>
          + Move In
        </button>
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th onClick={() => handleSort('name')}    style={{ cursor:'pointer', userSelect:'none' }}>Name{arrow('name')}</th>
              <th onClick={() => handleSort('room')}    style={{ cursor:'pointer', userSelect:'none' }}>Room{arrow('room')}</th>
              <th onClick={() => handleSort('bed')}     style={{ cursor:'pointer', userSelect:'none' }}>Bed{arrow('bed')}</th>
              <th onClick={() => handleSort('rate')}    style={{ cursor:'pointer', userSelect:'none' }}>Rate{arrow('rate')}</th>
              <th onClick={() => handleSort('movein')}  style={{ cursor:'pointer', userSelect:'none' }}>Move In{arrow('movein')}</th>
              <th onClick={() => handleSort('moveout')} style={{ cursor:'pointer', userSelect:'none' }}>Move Out{arrow('moveout')}</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {pageRows.length === 0
              ? <tr><td colSpan={7}><div className="empty"><div className="empty-icon">🔍</div><p>No tenants found</p></div></td></tr>
              : pageRows.map(t => (
                <tr key={t.id}>
                  <td className="td-name">{t.name}</td>
                  <td>{t.room_no}</td>
                  <td><strong>{t.bed_letter}</strong> <span style={{ color:'#94A3B8', fontSize:10 }}>{t.bed_location}</span></td>
                  <td className="td-rate">{fmt(t.rate)}</td>
                  <td>{fmtDate(t.move_in_date)}</td>
                  <td>{fmtDate(t.move_out_date)}</td>
                  <td>
                    <div className="td-actions">
                      <button className="btn-xs blue"  onClick={() => openDetail(t)}>View</button>
                      <button className="btn-xs green" onClick={() => { setPayModal(t); setPayDate(today()) }}>Pay</button>
                      <button className="btn-xs red"   onClick={() => setMoveOutT(t)}>Move Out</button>
                    </div>
                  </td>
                </tr>
              ))
            }
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="pager">
          {Array.from({ length: totalPages }, (_, i) => (
            <button key={i} className={i === page ? 'active' : ''} onClick={() => setPage(i)}>{i+1}</button>
          ))}
          <span className="pager-info">{filtered.length} tenants</span>
        </div>
      )}

      {/* ── Detail Modal ── */}
      {detail && (
        <div className="overlay" onClick={e => e.target === e.currentTarget && setDetail(null)}>
          <div className="modal">
            <div className="modal-head">
              <h3>👤 {detail.name}</h3>
              <button className="btn-close" onClick={() => setDetail(null)}>✕</button>
            </div>
            <div className="modal-body">
              {[
                ['Room No',        `${detail.room_no} · Bed ${detail.bed_letter} (${detail.bed_location || '—'})`],
                ['Room Type',      detail.room_type],
                ['Rate',           fmt(detail.rate)],
                ['Gender',         detail.gender],
                ['Duration',       detail.duration],
                ['Move In',        fmtDate(detail.move_in_date)],
                ['Move Out',       fmtDate(detail.move_out_date)],
                ['Contact No',     detail.contact_no],
                ['Email',          detail.email],
                ['Location of Work',detail.location_of_work],
                ['Work Schedule',  detail.work_schedule],
                ['Govt ID 1',      detail.govt_id1],
                ['Govt ID 2',      detail.govt_id2],
                ['Contract',       detail.contract],
                ['Emergency Name', detail.emergency_contact_name],
                ['Emergency No',   detail.emergency_contact_no],
                ['Comments',       detail.comments],
              ].filter(([,v]) => v).map(([l,v]) => (
                <div key={l} className="detail-row">
                  <div className="detail-label">{l}</div>
                  <div className="detail-value">{v}</div>
                </div>
              ))}

              {detailPays.length > 0 && (
                <>
                  <div style={{ marginTop:16, fontWeight:700, fontSize:12, color:'#64748B', textTransform:'uppercase', letterSpacing:'.5px' }}>
                    Payment History
                  </div>
                  <table className="payments-table">
                    <thead><tr><th>Date</th><th>Type</th><th>Amount</th><th>Notes</th></tr></thead>
                    <tbody>
                      {detailPays.map(p => (
                        <tr key={p.id}>
                          <td>{fmtDate(p.payment_date)}</td>
                          <td>{p.pay_type}</td>
                          <td>{fmt(p.amount)}</td>
                          <td>{p.notes || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </div>
            <div className="modal-foot">
              <button className="btn secondary" onClick={() => setDetail(null)}>Close</button>
              <button className="btn success"   onClick={() => { setDetail(null); setPayModal(detail); setPayDate(today()) }}>Record Payment</button>
              <button className="btn danger"    onClick={() => { setDetail(null); setMoveOutT(detail) }}>Move Out</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Payment Modal ── */}
      {payModal && (
        <div className="overlay" onClick={e => e.target === e.currentTarget && setPayModal(null)}>
          <div className="modal modal-sm">
            <div className="modal-head">
              <h3>💳 Record Payment</h3>
              <button className="btn-close" onClick={() => setPayModal(null)}>✕</button>
            </div>
            <div className="modal-body">
              <div style={{ padding:'10px 12px', background:'#F8FAFC', borderRadius:8, marginBottom:14, fontSize:13 }}>
                <strong>{payModal.name}</strong><br />
                Room {payModal.room_no} · Bed {payModal.bed_letter} · {fmt(payModal.rate)}/mo
              </div>
              <div className="form-grid">
                <div className="fg">
                  <label>Payment Type</label>
                  <select value={payType} onChange={e => setPayType(e.target.value)}>
                    <option value="10th">10th of Month</option>
                    <option value="EOM">End of Month</option>
                    <option value="Other">Other</option>
                  </select>
                </div>
                <div className="fg">
                  <label>Date Paid *</label>
                  <input type="date" value={payDate} onChange={e => setPayDate(e.target.value)} required />
                </div>
              </div>
            </div>
            <div className="modal-foot">
              <button className="btn secondary" onClick={() => setPayModal(null)}>Cancel</button>
              <button className="btn primary" disabled={saving || !payDate} onClick={handlePayment}>
                {saving ? 'Saving…' : '✓ Record'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Move In / Move Out modals */}
      {moveInBed && (
        <MoveInModal
          bed={moveInBed}
          allBeds={beds.filter(b => b.status === 'VACANT')}
          onBedChange={setMoveInBed}
          onClose={() => setMoveInBed(null)}
          onSubmit={handleMoveIn}
          saving={saving}
        />
      )}
      {moveOutT && (
        <MoveOutModal
          bed={{ ...moveOutT, tenant_name: moveOutT.name, move_out_date: moveOutT.move_out_date }}
          onClose={() => setMoveOutT(null)}
          onSubmit={handleMoveOut}
          saving={saving}
        />
      )}

      {ToastEl}
    </div>
  )
}
