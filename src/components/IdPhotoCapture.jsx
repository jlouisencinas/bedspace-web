import { useRef } from 'react'
import { Camera, RefreshCw, CheckCircle, Loader2, AlertTriangle } from 'lucide-react'
import { ID_TYPES } from '../lib/visitors'
import { compressIdPhoto, uploadIdPhoto } from '../lib/idPhoto'

export const EMPTY_PHOTO = { status: 'idle', previewUrl: null, blob: null, path: null, error: '', token: 0 }

export function releasePhoto(photo) {
  if (photo?.previewUrl) URL.revokeObjectURL(photo.previewUrl)
}

let tokenSeq = 0

// The photo uploads as soon as it is taken; the parent only links the returned path at check-in.
export default function IdPhotoCapture({ photo, setPhoto, idType, setIdType, idTypeOther, setIdTypeOther, missing = {} }) {
  const inputRef = useRef(null)
  const current = useRef(0)

  async function upload(blob, token) {
    setPhoto(p => (p.token === token ? { ...p, status: 'uploading', error: '' } : p))
    try {
      const path = await uploadIdPhoto(blob)
      setPhoto(p => (p.token === token ? { ...p, status: 'ready', path } : p))
    } catch (e) {
      setPhoto(p => (p.token === token ? { ...p, status: 'error', path: null, error: e.message } : p))
    }
  }

  async function onFile(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    const token = ++tokenSeq
    current.current = token
    setPhoto(p => { releasePhoto(p); return { ...EMPTY_PHOTO, status: 'processing', token } })
    let blob
    try {
      blob = await compressIdPhoto(file)
    } catch (err) {
      setPhoto(p => (p.token === token ? { ...EMPTY_PHOTO, status: 'error', error: err.message, token } : p))
      return
    }
    if (current.current !== token) return
    const previewUrl = URL.createObjectURL(blob)
    setPhoto(p => (p.token === token ? { ...p, previewUrl, blob } : p))
    upload(blob, token)
  }

  const retry = () => {
    if (!photo.blob) { inputRef.current?.click(); return }
    const token = ++tokenSeq
    current.current = token
    setPhoto(p => ({ ...p, token }))
    upload(photo.blob, token)
  }

  const busy = photo.status === 'processing' || photo.status === 'uploading'

  return (
    <div className="space-y-4">
      <div>
        <div className="text-[14px] font-semibold text-ink mb-2">ID type</div>
        <div className={`flex flex-wrap gap-2 rounded-xl ${missing.idType ? 'p-1 border border-danger-border' : ''}`} role="radiogroup" aria-label="ID type">
          {ID_TYPES.map(t => {
            const active = idType === t.value
            return (
              <button key={t.value} type="button" role="radio" aria-checked={active} onClick={() => setIdType(t.value)}
                className={`min-h-[48px] px-4 rounded-full border text-[14px] font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-navy-500
                  ${active ? 'bg-navy-500 text-navy-950 border-navy-500' : 'bg-surface text-ink border-line hover:bg-surface-hover'}`}>
                {t.label}
              </button>
            )
          })}
        </div>
        {idType === 'OTHER' && (
          <div className="fg mt-3">
            <label htmlFor="id-type-other">Specify ID type</label>
            <input id="id-type-other" type="text" value={idTypeOther} maxLength={40} onChange={e => setIdTypeOther(e.target.value)}
              placeholder="e.g. Barangay ID" className={`!text-[16px] !py-3 ${missing.idTypeOther ? '!border-danger-border' : ''}`} />
          </div>
        )}
      </div>

      <div>
        <input ref={inputRef} type="file" accept="image/*" capture="environment" className="sr-only" onChange={onFile}
          tabIndex={-1} aria-hidden="true" />
        {photo.status === 'idle' ? (
          <button type="button" onClick={() => inputRef.current?.click()}
            className={`w-full min-h-[56px] rounded-xl border-2 border-dashed flex items-center justify-center gap-2 text-[16px] font-semibold text-ink bg-surface-2 hover:bg-surface-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-navy-500
              ${missing.photo ? 'border-danger-border' : 'border-line'}`}>
            <Camera size={22} /> Take ID photo
          </button>
        ) : (
          <div className={`flex items-center gap-3 p-3 rounded-xl border ${photo.status === 'error' ? 'border-danger-border bg-danger-bg' : 'border-line bg-surface-2'}`}>
            {photo.previewUrl
              ? <img src={photo.previewUrl} alt="ID photo preview" className="h-24 w-auto max-w-[45%] rounded-lg object-contain bg-surface border border-line" />
              : <div className="h-24 w-24 rounded-lg bg-surface-3 flex items-center justify-center text-ink-faint"><Camera size={24} /></div>}
            <div className="flex-1 min-w-0 space-y-2">
              <div className="text-[14px] font-medium flex items-start gap-1.5">
                {photo.status === 'processing' && <><Loader2 size={16} className="animate-spin shrink-0 mt-0.5 text-ink-muted" /><span className="text-ink-secondary">Preparing photo…</span></>}
                {photo.status === 'uploading' && <><Loader2 size={16} className="animate-spin shrink-0 mt-0.5 text-ink-muted" /><span className="text-ink-secondary">Uploading…</span></>}
                {photo.status === 'ready' && <><CheckCircle size={16} className="shrink-0 mt-0.5 text-success-text" /><span className="text-success-text">Photo ready</span></>}
                {photo.status === 'error' && <><AlertTriangle size={16} className="shrink-0 mt-0.5 text-danger-text" /><span className="text-danger-text break-words">{photo.blob ? `Upload failed — ${photo.error}` : photo.error}</span></>}
              </div>
              <div className="flex flex-wrap gap-2">
                {photo.status === 'error' && photo.blob && (
                  <button type="button" onClick={retry} className="btn secondary !min-h-[48px]"><RefreshCw size={14} /> Retry</button>
                )}
                <button type="button" onClick={() => inputRef.current?.click()} disabled={photo.status === 'processing'}
                  className="btn secondary !min-h-[48px]"><Camera size={14} /> Retake</button>
              </div>
            </div>
          </div>
        )}
        {busy && <span className="sr-only" aria-live="polite">Uploading ID photo</span>}
      </div>
    </div>
  )
}
