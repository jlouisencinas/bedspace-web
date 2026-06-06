import { useState, useEffect } from 'react'

export default function MoveInModal({ bed, allBeds, onBedChange, onClose, onSubmit, saving }) {
  const [form, setForm] = useState({
    name:'', gender:'', rate: bed?.default_rate || '', duration:'',
    move_in_date: today(), move_out_date:'',
    contact_no:'', email:'', location_of_work:'', work_schedule:'',
    govt_id1:'', govt_id2:'', contract:'',
    emergency_contact_name:'', emergency_contact_no:'',
    comments:'',
  })

  function today() { return new Date().toISOString().slice(0,10) }

  // Update rate when bed changes
  useEffect(() => {
    if (bed) setForm(f => ({ ...f, rate: bed.default_rate || '' }))
  }, [bed])

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  function handleSubmit(e) {
    e.preventDefault()
    if (!form.name.trim() || !form.rate || !form.move_in_date) return
    onSubmit(form)
  }

  return (
    <div className="overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-head">
          <h3>🏠 Move In New Tenant</h3>
          <button className="btn-close" onClick={onClose}>✕</button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            <div className="form-grid">

              <div className="form-section">Room & Bed</div>

              {/* If allBeds is provided (from Tenants page), show a selector */}
              {allBeds && (
                <div className="fg full">
                  <label>Select Vacant Bed *</label>
                  <select
                    value={bed?.bed_id || ''}
                    onChange={e => {
                      const b = allBeds.find(b => b.bed_id == e.target.value)
                      if (b && onBedChange) onBedChange(b)
                    }}
                    required
                  >
                    <option value="">Select…</option>
                    {allBeds.map(b => (
                      <option key={b.bed_id} value={b.bed_id}>
                        Room {b.room_no} · Bed {b.bed_letter} {b.bed_location ? `(${b.bed_location})` : ''} — {b.room_type}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {!allBeds && bed && (
                <div className="fg full">
                  <label>Selected Bed</label>
                  <input type="text" readOnly
                    value={`Room ${bed.room_no} · Bed ${bed.bed_letter}${bed.bed_location ? ' (' + bed.bed_location + ')' : ''} — ${bed.room_type || ''}`}
                    style={{ background:'#F8FAFC', color:'#475569' }}
                  />
                </div>
              )}

              <div className="fg">
                <label>Rate (PHP) *</label>
                <input type="number" value={form.rate} onChange={e => set('rate', e.target.value)} required min="0" step="0.01" />
              </div>
              <div className="fg">
                <label>Duration</label>
                <input type="text" placeholder="e.g. 12 Months" value={form.duration} onChange={e => set('duration', e.target.value)} />
              </div>

              <div className="form-section">Tenant Info</div>

              <div className="fg full">
                <label>Full Name *</label>
                <input type="text" value={form.name} onChange={e => set('name', e.target.value)} required placeholder="Last, First Middle" />
              </div>
              <div className="fg">
                <label>Gender</label>
                <select value={form.gender} onChange={e => set('gender', e.target.value)}>
                  <option value="">—</option>
                  <option value="F">Female</option>
                  <option value="M">Male</option>
                </select>
              </div>
              <div className="fg">
                <label>Contact No</label>
                <input type="text" value={form.contact_no} onChange={e => set('contact_no', e.target.value)} placeholder="09xx-xxx-xxxx" />
              </div>
              <div className="fg">
                <label>Move In Date *</label>
                <input type="date" value={form.move_in_date} onChange={e => set('move_in_date', e.target.value)} required />
              </div>
              <div className="fg">
                <label>Move Out Date</label>
                <input type="date" value={form.move_out_date} onChange={e => set('move_out_date', e.target.value)} />
              </div>
              <div className="fg">
                <label>Email</label>
                <input type="email" value={form.email} onChange={e => set('email', e.target.value)} />
              </div>
              <div className="fg">
                <label>Location of Work</label>
                <input type="text" value={form.location_of_work} onChange={e => set('location_of_work', e.target.value)} />
              </div>
              <div className="fg">
                <label>Work Schedule</label>
                <input type="text" placeholder="Day / Night" value={form.work_schedule} onChange={e => set('work_schedule', e.target.value)} />
              </div>

              <div className="form-section">Government IDs & Contract</div>

              <div className="fg">
                <label>Govt ID 1</label>
                <input type="text" value={form.govt_id1} onChange={e => set('govt_id1', e.target.value)} />
              </div>
              <div className="fg">
                <label>Govt ID 2</label>
                <input type="text" value={form.govt_id2} onChange={e => set('govt_id2', e.target.value)} />
              </div>
              <div className="fg full">
                <label>Contract</label>
                <input type="text" value={form.contract} onChange={e => set('contract', e.target.value)} />
              </div>

              <div className="form-section">Emergency Contact</div>

              <div className="fg">
                <label>Name</label>
                <input type="text" value={form.emergency_contact_name} onChange={e => set('emergency_contact_name', e.target.value)} />
              </div>
              <div className="fg">
                <label>Contact No</label>
                <input type="text" value={form.emergency_contact_no} onChange={e => set('emergency_contact_no', e.target.value)} />
              </div>

              <div className="fg full">
                <label>Comments</label>
                <textarea value={form.comments} onChange={e => set('comments', e.target.value)} />
              </div>
            </div>
          </div>
          <div className="modal-foot">
            <button type="button" className="btn secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn success" disabled={saving}>
              {saving ? 'Saving…' : '✓ Confirm Move In'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
