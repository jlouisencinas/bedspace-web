import { useState, useEffect, useMemo } from 'react'
import { fetchActivityLog } from '../lib/supabase'

function fmt(n) { return n ? '₱' + Number(n).toLocaleString('en-PH') : '—' }
function fmtDate(d) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('en-PH', { month:'short', day:'numeric', year:'numeric' })
}
function fmtDateTime(d) {
  if (!d) return '—'
  return new Date(d).toLocaleString('en-PH', {
    month:'short', day:'numeric', year:'numeric', hour:'numeric', minute:'2-digit'
  })
}

export default function Activity() {
  const [logs,     setLogs]     = useState([])
  const [loading,  setLoading]  = useState(true)
  const [search,   setSearch]   = useState('')
  const [typeFilter,setTypeFilter] = useState('')

  useEffect(() => {
    fetchActivityLog()
      .then(setLogs)
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [])

  const filtered = useMemo(() => {
    const q = search.toLowerCase()
    return logs.filter(r => {
      if (typeFilter && r.activity_type !== typeFilter) return false
      if (q && !(r.tenant_name||'').toLowerCase().includes(q)) return false
      return true
    })
  }, [logs, search, typeFilter])

  if (loading) return (
    <div className="loading-screen">
      <div className="spinner" />
      <span style={{ color:'#1B3A8C', fontWeight:600 }}>Loading…</span>
    </div>
  )

  return (
    <div className="page">
      <div className="page-title">
        Activity Log
        <small>{filtered.length} records</small>
      </div>

      <div className="toolbar">
        <input
          type="search" placeholder="Search tenant name…"
          value={search} onChange={e => setSearch(e.target.value)}
        />
        <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)}>
          <option value="">All Types</option>
          <option value="Move In">Move In</option>
          <option value="Move Out">Move Out</option>
        </select>
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Recorded</th>
              <th>Name</th>
              <th>Room / Bed</th>
              <th>Rate</th>
              <th>Move In</th>
              <th>Move Out</th>
              <th>Amount Paid</th>
              <th>Type</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0
              ? <tr><td colSpan={8}><div className="empty"><div className="empty-icon">📋</div><p>No activity records</p></div></td></tr>
              : filtered.map((r, i) => (
                <tr key={i}>
                  <td style={{ whiteSpace:'nowrap', fontSize:12 }}>{fmtDateTime(r.recorded_at)}</td>
                  <td className="td-name">{r.tenant_name}</td>
                  <td>Rm {r.room_no} · Bed {r.bed_letter}</td>
                  <td className="td-rate">{fmt(r.rate)}</td>
                  <td>{fmtDate(r.move_in_date)}</td>
                  <td>{fmtDate(r.move_out_date)}</td>
                  <td>{fmt(r.amount_paid)}</td>
                  <td>
                    <span className={`badge ${r.activity_type === 'Move In' ? 'movein' : 'moveout'}`}>
                      {r.activity_type}
                    </span>
                  </td>
                </tr>
              ))
            }
          </tbody>
        </table>
      </div>
    </div>
  )
}
