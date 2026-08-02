import { useState, useEffect, useMemo } from 'react'
import { fetchActivityLog } from '../lib/supabase'
import { Search, ClipboardList } from 'lucide-react'

function fmt(n) { return n ? '₱' + Number(n).toLocaleString('en-PH') : '—' }
function fmtDate(d) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('en-PH', { month:'short', day:'numeric', year:'numeric' })
}
function fmtDateTime(d) {
  if (!d) return '—'
  return new Date(d).toLocaleString('en-PH', {
    month:'short', day:'numeric', year:'numeric', hour:'numeric', minute:'2-digit',
  })
}

const TYPE_CONFIG = {
  // Tenants
  'Move In':                    { bg: 'bg-emerald-50',  text: 'text-emerald-700',  dot: 'bg-emerald-500'  },
  'Move Out':                   { bg: 'bg-red-50',      text: 'text-red-700',      dot: 'bg-red-400'      },
  'Room Transfer':              { bg: 'bg-blue-50',     text: 'text-blue-700',     dot: 'bg-blue-500'     },
  // Payments
  'Payment - Rent + Water':     { bg: 'bg-navy-50',     text: 'text-navy-700',     dot: 'bg-navy-500'     },
  'Payment - Electricity':      { bg: 'bg-blue-50',     text: 'text-blue-700',     dot: 'bg-blue-400'     },
  'Payment - Other':            { bg: 'bg-slate-100',   text: 'text-slate-600',    dot: 'bg-slate-400'    },
  // Approvals
  'Approval Requested':         { bg: 'bg-amber-50',    text: 'text-amber-700',    dot: 'bg-amber-500'    },
  'Approval Approved':          { bg: 'bg-blue-50',     text: 'text-blue-700',     dot: 'bg-blue-500'     },
  'Approval Rejected':          { bg: 'bg-rose-50',     text: 'text-rose-700',     dot: 'bg-rose-400'     },
  // Billing
  'Cutoff Opened':              { bg: 'bg-emerald-50',  text: 'text-emerald-700',  dot: 'bg-emerald-400'  },
  'Cutoff Updated':             { bg: 'bg-slate-100',   text: 'text-slate-600',    dot: 'bg-slate-400'    },
  'Cutoff Deleted':             { bg: 'bg-rose-50',     text: 'text-rose-700',     dot: 'bg-rose-400'     },
  'Meter Readings Saved':       { bg: 'bg-indigo-50',   text: 'text-indigo-700',   dot: 'bg-indigo-400'   },
  'Interim Reading Added':      { bg: 'bg-violet-50',   text: 'text-violet-700',   dot: 'bg-violet-400'   },
  'Interim Reading Deleted':    { bg: 'bg-rose-50',     text: 'text-rose-600',     dot: 'bg-rose-300'     },
  'Add-on Saved':               { bg: 'bg-teal-50',     text: 'text-teal-700',     dot: 'bg-teal-400'     },
  'Add-on Updated':             { bg: 'bg-teal-50',     text: 'text-teal-600',     dot: 'bg-teal-300'     },
  'Add-on Deleted':             { bg: 'bg-rose-50',     text: 'text-rose-600',     dot: 'bg-rose-300'     },
  'Room Split Updated':         { bg: 'bg-purple-50',   text: 'text-purple-700',   dot: 'bg-purple-400'   },
  // Tickets
  'Ticket Raised':              { bg: 'bg-amber-50',    text: 'text-amber-700',    dot: 'bg-amber-400'    },
  'Ticket Resolved':            { bg: 'bg-emerald-50',  text: 'text-emerald-600',  dot: 'bg-emerald-400'  },
  // Property
  'Room Config Updated':        { bg: 'bg-blue-50',     text: 'text-blue-700',     dot: 'bg-blue-400'     },
  'Bed Rate Updated':           { bg: 'bg-indigo-50',   text: 'text-indigo-700',   dot: 'bg-indigo-400'   },
  'Bed Removed':                { bg: 'bg-rose-50',     text: 'text-rose-700',     dot: 'bg-rose-400'     },
  'Add-on Type Created':        { bg: 'bg-teal-50',     text: 'text-teal-700',     dot: 'bg-teal-400'     },
  'Add-on Type Updated':        { bg: 'bg-teal-50',     text: 'text-teal-600',     dot: 'bg-teal-300'     },
  'Add-on Type Deleted':        { bg: 'bg-rose-50',     text: 'text-rose-600',     dot: 'bg-rose-300'     },
  // System
  'Bed Status Changed':         { bg: 'bg-slate-100',   text: 'text-slate-500',    dot: 'bg-slate-300'    },
}

const APPROVAL_TYPES = new Set(['Approval Requested', 'Approval Approved', 'Approval Rejected'])
const PAYMENT_TYPES  = new Set(['Payment - Rent + Water', 'Payment - Electricity', 'Payment - Other'])
const BILLING_TYPES  = new Set([
  'Cutoff Opened', 'Cutoff Updated', 'Cutoff Deleted',
  'Meter Readings Saved', 'Interim Reading Added', 'Interim Reading Deleted',
  'Add-on Saved', 'Add-on Updated', 'Add-on Deleted', 'Room Split Updated',
  'Bed Status Changed', 'Ticket Raised', 'Ticket Resolved',
  'Room Config Updated', 'Bed Rate Updated', 'Bed Removed',
  'Add-on Type Created', 'Add-on Type Updated', 'Add-on Type Deleted',
])

function TypeBadge({ type }) {
  const c = TYPE_CONFIG[type] || { bg: 'bg-slate-100', text: 'text-slate-500', dot: 'bg-slate-400' }
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold whitespace-nowrap ${c.bg} ${c.text}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${c.dot}`} />
      {type}
    </span>
  )
}

export default function Activity() {
  const [logs,       setLogs]      = useState([])
  const [loading,    setLoading]   = useState(true)
  const [search,     setSearch]    = useState('')
  const [typeFilter, setTypeFilter] = useState('')

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
      if (q) {
        const h = [r.tenant_name, r.room_no, r.notes].filter(Boolean).join(' ').toLowerCase()
        if (!h.includes(q)) return false
      }
      return true
    })
  }, [logs, search, typeFilter])

  if (loading) return (
    <div className="loading-screen">
      <div className="spinner" />
      <span className="text-navy-500 font-semibold text-sm">Loading…</span>
    </div>
  )

  return (
    <div className="page">
      {/* ── Header ── */}
      <div className="page-header">
        <div>
          <h1 className="page-title">Activity Log</h1>
          <p className="page-sub">All recorded tenant and approval events</p>
        </div>
        <div className="text-[12px] font-semibold text-slate-400">
          {filtered.length} records
        </div>
      </div>

      {/* ── Toolbar ── */}
      <div className="toolbar">
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="search"
            placeholder="Search name, room, or notes…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-9 pr-3 py-2 border border-slate-200 rounded-lg text-[13px] bg-white w-64
                       focus:outline-none focus:ring-2 focus:ring-navy-700/10 focus:border-navy-600 transition-colors"
          />
        </div>
        <select
          value={typeFilter}
          onChange={e => setTypeFilter(e.target.value)}
          className="px-3 py-2 border border-slate-200 rounded-lg text-[13px] bg-white
                     focus:outline-none focus:ring-2 focus:ring-navy-700/10 focus:border-navy-600 transition-colors"
        >
          <option value="">All Types</option>
          <optgroup label="Tenants">
            <option value="Move In">Move In</option>
            <option value="Move Out">Move Out</option>
            <option value="Room Transfer">Room Transfer</option>
          </optgroup>
          <optgroup label="Payments">
            <option value="Payment - Rent + Water">Payment - Rent + Water</option>
            <option value="Payment - Electricity">Payment - Electricity</option>
            <option value="Payment - Other">Payment - Other</option>
          </optgroup>
          <optgroup label="Approvals">
            <option value="Approval Requested">Approval Requested</option>
            <option value="Approval Approved">Approval Approved</option>
            <option value="Approval Rejected">Approval Rejected</option>
          </optgroup>
          <optgroup label="Billing">
            <option value="Cutoff Opened">Cutoff Opened</option>
            <option value="Cutoff Updated">Cutoff Updated</option>
            <option value="Cutoff Deleted">Cutoff Deleted</option>
            <option value="Meter Readings Saved">Meter Readings Saved</option>
            <option value="Interim Reading Added">Interim Reading Added</option>
            <option value="Interim Reading Deleted">Interim Reading Deleted</option>
            <option value="Add-on Saved">Add-on Saved</option>
            <option value="Add-on Updated">Add-on Updated</option>
            <option value="Add-on Deleted">Add-on Deleted</option>
            <option value="Room Split Updated">Room Split Updated</option>
          </optgroup>
          <optgroup label="Tickets">
            <option value="Ticket Raised">Ticket Raised</option>
            <option value="Ticket Resolved">Ticket Resolved</option>
          </optgroup>
          <optgroup label="Property">
            <option value="Room Config Updated">Room Config Updated</option>
            <option value="Bed Rate Updated">Bed Rate Updated</option>
            <option value="Bed Removed">Bed Removed</option>
            <option value="Add-on Type Created">Add-on Type Created</option>
            <option value="Add-on Type Updated">Add-on Type Updated</option>
            <option value="Add-on Type Deleted">Add-on Type Deleted</option>
          </optgroup>
          <optgroup label="System">
            <option value="Bed Status Changed">Bed Status Changed</option>
          </optgroup>
        </select>
      </div>

      {/* ── Table ── */}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Recorded</th>
              <th>Type</th>
              <th>Tenant</th>
              <th>Room / Bed</th>
              <th>Rate</th>
              <th>Move In</th>
              <th>Move Out</th>
              <th>Amount</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={9}>
                  <div className="empty"><ClipboardList size={32} className="mx-auto mb-3 text-slate-300" /><p>No activity records</p></div>
                </td>
              </tr>
            ) : filtered.map((r, i) => {
              const isApproval   = APPROVAL_TYPES.has(r.activity_type)
              const isPayment    = PAYMENT_TYPES.has(r.activity_type)
              const isBilling    = BILLING_TYPES.has(r.activity_type)
              const hideTenantCols = isApproval || isPayment || isBilling
              return (
                <tr key={i} className={isApproval ? 'bg-amber-50/40' : isPayment ? 'bg-navy-50/20' : isBilling ? 'bg-slate-50/60' : ''}>
                  <td className="whitespace-nowrap text-[11px] text-slate-400 font-medium">
                    {fmtDateTime(r.recorded_at)}
                  </td>
                  <td><TypeBadge type={r.activity_type} /></td>
                  <td className="td-name">{r.tenant_name || '—'}</td>
                  <td className="text-[12px] whitespace-nowrap">
                    {r.room_no ? `Rm ${r.room_no}${r.bed_letter ? ` · ${r.bed_letter}` : ''}` : '—'}
                  </td>
                  <td className="td-rate">{hideTenantCols ? '—' : fmt(r.rate)}</td>
                  <td className="text-[12px] text-slate-500">{hideTenantCols ? '—' : fmtDate(r.move_in_date)}</td>
                  <td className="text-[12px] text-slate-500">{hideTenantCols ? '—' : fmtDate(r.move_out_date)}</td>
                  <td className="text-[12px] font-semibold text-emerald-700">{fmt(r.amount_paid)}</td>
                  <td className="text-[11px] text-slate-500 max-w-[260px]">
                    {r.notes
                      ? <span title={r.notes} className="line-clamp-2">{r.notes}</span>
                      : <span className="text-slate-300">—</span>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
