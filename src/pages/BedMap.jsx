import { useState, useEffect, useMemo } from 'react'
import { fetchBeds, updateBedStatus, addTenant, processMoveOut } from '../lib/supabase'
import { useToast } from '../components/Toast'
import MoveInModal  from '../components/MoveInModal'
import MoveOutModal from '../components/MoveOutModal'

function statusClass(s) {
  if (!s) return 'vacant'
  switch (s.toUpperCase()) {
    case 'LEASED':       return 'leased'
    case 'RESERVED':     return 'reserved'
    case 'OUT OF ORDER': return 'oor'
    default:             return 'vacant'
  }
}

export default function BedMap() {
  const [beds,      setBeds]      = useState([])
  const [loading,   setLoading]   = useState(true)
  const [search,    setSearch]    = useState('')
  const [typeFilter,setTypeFilter]= useState('')
  const [statFilter,setStatFilter]= useState('')
  const [moveInBed, setMoveInBed] = useState(null)
  const [moveOutBed,setMoveOutBed]= useState(null)
  const { show, ToastEl } = useToast()

  async function load() {
    setLoading(true)
    try { setBeds(await fetchBeds()) } catch (e) { show(e.message, 'error') }
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  const roomTypes = useMemo(() =>
    [...new Set(beds.map(b => b.room_type).filter(Boolean))].sort(), [beds])

  const grouped = useMemo(() => {
    const q = search.toLowerCase()
    const map = {}
    beds.forEach(b => {
      if (typeFilter && b.room_type !== typeFilter) return
      if (statFilter && b.status !== statFilter)    return
      if (q && !b.room_no.includes(q) && !(b.tenant_name||'').toLowerCase().includes(q)) return
      if (!map[b.room_no]) map[b.room_no] = { room_type: b.room_type, floor: b.floor, beds: [] }
      map[b.room_no].beds.push(b)
    })
    Object.values(map).forEach(r => r.beds.sort((a,b) => a.bed_letter.localeCompare(b.bed_letter)))
    return Object.entries(map).sort((a,b) => parseInt(a[0]) - parseInt(b[0]))
  }, [beds, search, typeFilter, statFilter])

  async function markStatus(bed, status) {
    try {
      await updateBedStatus(bed.bed_id, status)
      show(`Bed ${bed.bed_letter} marked as ${status}`, 'success')
      load()
    } catch(e) { show(e.message, 'error') }
  }

  async function handleMoveIn(data) {
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
  }

  async function handleMoveOut(data) {
    try {
      await processMoveOut(
        { ...moveOutBed, _room_no: moveOutBed.room_no, _bed_letter: moveOutBed.bed_letter },
        data
      )
      setMoveOutBed(null)
      show('Move-out processed.', 'success')
      load()
    } catch(e) { show(e.message, 'error') }
  }

  if (loading) return (
    <div className="loading-screen">
      <div className="spinner" />
      <span style={{ color:'#1B3A8C', fontWeight:600 }}>Loading…</span>
    </div>
  )

  return (
    <div className="page" style={{ maxWidth: 1600 }}>
      <div className="page-title">
        Bed Map
        <small>{grouped.length} rooms shown</small>
      </div>

      <div className="toolbar">
        <input
          type="search" placeholder="Search room or tenant…"
          value={search} onChange={e => setSearch(e.target.value)}
        />
        <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)}>
          <option value="">All Room Types</option>
          {roomTypes.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <select value={statFilter} onChange={e => setStatFilter(e.target.value)}>
          <option value="">All Statuses</option>
          <option value="LEASED">Leased</option>
          <option value="VACANT">Vacant</option>
          <option value="RESERVED">Reserved</option>
          <option value="OUT OF ORDER">Out of Order</option>
        </select>
      </div>

      {grouped.length === 0
        ? <div className="empty"><div className="empty-icon">🔍</div><p>No rooms match your filter</p></div>
        : (
          <div className="rooms-grid">
            {grouped.map(([roomNo, room]) => {
              const occ = room.beds.filter(b => b.status === 'LEASED').length
              return (
                <div key={roomNo} className="room-card">
                  <div className="room-card-head">
                    <div>
                      <div className="room-no">Room {roomNo}</div>
                      <div className="room-type">{room.room_type}</div>
                    </div>
                    <div className="room-occ">{occ}/{room.beds.length} occupied</div>
                  </div>
                  <div className="bed-list">
                    {room.beds.map(b => {
                      const cls = statusClass(b.status)
                      return (
                        <div key={b.bed_id} className="bed-row">
                          <div className={`bed-dot ${cls}`} title={b.status}>{b.bed_letter}</div>
                          <div className="bed-info">
                            <div className="bed-name" title={b.status === 'LEASED' ? b.tenant_name : b.status}>
                              {b.status === 'LEASED' ? b.tenant_name : b.status}
                            </div>
                            <div className="bed-meta">
                              {b.bed_location && b.bed_location + ' · '}
                              {b.rate || b.default_rate
                                ? '₱' + Number(b.rate || b.default_rate).toLocaleString('en-PH')
                                : ''}
                            </div>
                          </div>
                          <div className="bed-btns">
                            {b.status === 'VACANT' && <>
                              <button className="btn-xs green" onClick={() => setMoveInBed(b)}>Move In</button>
                              <button className="btn-xs amber" onClick={() => markStatus(b, 'RESERVED')}>Reserve</button>
                              <button className="btn-xs gray"  onClick={() => markStatus(b, 'OUT OF ORDER')}>OOO</button>
                            </>}
                            {b.status === 'RESERVED' && <>
                              <button className="btn-xs green" onClick={() => setMoveInBed(b)}>Move In</button>
                              <button className="btn-xs gray"  onClick={() => markStatus(b, 'VACANT')}>Cancel</button>
                              <button className="btn-xs gray"  onClick={() => markStatus(b, 'OUT OF ORDER')}>OOO</button>
                            </>}
                            {b.status === 'LEASED' && <>
                              <button className="btn-xs red"  onClick={() => setMoveOutBed(b)}>Move Out</button>
                              <button className="btn-xs gray" onClick={() => markStatus(b, 'OUT OF ORDER')}>OOO</button>
                            </>}
                            {b.status === 'OUT OF ORDER' && <>
                              <button className="btn-xs green" onClick={() => markStatus(b, 'VACANT')}>Restore</button>
                              <button className="btn-xs amber" onClick={() => markStatus(b, 'RESERVED')}>Reserve</button>
                            </>}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>
        )
      }

      {moveInBed && (
        <MoveInModal
          bed={moveInBed}
          onClose={() => setMoveInBed(null)}
          onSubmit={handleMoveIn}
        />
      )}
      {moveOutBed && (
        <MoveOutModal
          bed={moveOutBed}
          onClose={() => setMoveOutBed(null)}
          onSubmit={handleMoveOut}
        />
      )}
      {ToastEl}
    </div>
  )
}
