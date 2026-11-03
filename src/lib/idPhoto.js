import { supabase } from './supabase'

export const PHOTO_BUCKET = 'visitor-ids'
const MAX_BYTES = 1048576
const TARGET_BYTES = 300 * 1024
const ATTEMPTS = [[1280, 0.7], [1280, 0.6], [1280, 0.5], [1024, 0.5]]
const PURGE_KEY = 'bedspace.visitorPhotoPurge.lastRun'
const PURGE_EVERY_MS = 6 * 60 * 60 * 1000

async function decode(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' })
      return { source: bmp, width: bmp.width, height: bmp.height, done: () => bmp.close?.() }
    } catch { /* older Safari rejects the options bag; the <img> path below still applies EXIF orientation */ }
  }
  const url = URL.createObjectURL(file)
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    if (!img.naturalWidth || !img.naturalHeight) throw new Error('empty image')
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, done: () => URL.revokeObjectURL(url) }
  } catch (e) {
    URL.revokeObjectURL(url)
    throw e
  }
}

function encode(img, maxEdge, quality) {
  const scale = Math.min(1, maxEdge / Math.max(img.width, img.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(img.width * scale))
  canvas.height = Math.max(1, Math.round(img.height * scale))
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(img.source, 0, 0, canvas.width, canvas.height)
  return new Promise((resolve, reject) => canvas.toBlob(b => {
    if (!b || b.type !== 'image/jpeg') reject(new Error("Couldn't prepare this photo, take it again."))
    else resolve(b)
  }, 'image/jpeg', quality))
}

// Re-encoding on a canvas drops EXIF/GPS; orientation is applied while decoding.
export async function compressIdPhoto(file) {
  if (!file || !String(file.type || '').startsWith('image/')) throw new Error('Not an image. Take a photo of the ID.')
  let img
  try { img = await decode(file) } catch { throw new Error("Couldn't read this photo, take it again.") }
  try {
    let blob = null
    for (const [edge, q] of ATTEMPTS) {
      blob = await encode(img, edge, q)
      if (blob.size <= TARGET_BYTES) break
    }
    if (!blob || blob.size > MAX_BYTES) throw new Error('This photo is too large even after compression. Take it again.')
    return blob
  } finally {
    img.done()
  }
}

function manilaYearMonth() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit' }).formatToParts(new Date())
  const p = t => parts.find(x => x.type === t)?.value
  return [p('year'), p('month')]
}

export async function uploadIdPhoto(blob) {
  const [yyyy, mm] = manilaYearMonth()
  const path = `${yyyy}/${mm}/${crypto.randomUUID()}.jpg`
  const { error } = await supabase.storage.from(PHOTO_BUCKET).upload(path, blob, { contentType: 'image/jpeg', upsert: false })
  if (error) throw new Error(`Upload failed: ${error.message}`)
  return path
}

// Admin only (storage SELECT policy). 2-minute URL, fetched on demand, never stored.
export async function signedPhotoUrl(path) {
  const { data, error } = await supabase.storage.from(PHOTO_BUCKET).createSignedUrl(path, 120)
  if (error) throw new Error(error.message)
  if (!data?.signedUrl) throw new Error('No photo URL returned.')
  return data.signedUrl
}

export async function runPhotoPurge({ maxBatches = 5 } = {}) {
  let expired = 0, orphans = 0
  for (let i = 0; i < maxBatches; i++) {
    const { data: cands, error } = await supabase.rpc('visitor_photo_purge_candidates', { p_limit: 200 })
    if (error) throw new Error(error.message)
    if (!cands?.length) break
    const paths = cands.map(c => c.path)
    const removed = new Set()
    for (let j = 0; j < paths.length; j += 100) {
      const { data, error: rmErr } = await supabase.storage.from(PHOTO_BUCKET).remove(paths.slice(j, j + 100))
      if (rmErr) throw new Error(`Removing photos failed: ${rmErr.message}`)
      for (const o of data || []) removed.add(o.name)
    }
    const expiredPaths = cands.filter(c => c.kind === 'EXPIRED').map(c => c.path)
    if (expiredPaths.length) {
      const { data: n, error: mErr } = await supabase.rpc('visitor_photo_mark_purged', { p_paths: expiredPaths })
      if (mErr) throw new Error(mErr.message)
      expired += Number(n) || 0
    }
    orphans += cands.filter(c => c.kind === 'ORPHAN' && removed.has(c.path)).length
    if (!removed.size || cands.length < 200) break
  }
  return { expired, orphans }
}

export async function maybeAutoPurge() {
  const last = Number(localStorage.getItem(PURGE_KEY) || 0)
  if (Number.isFinite(last) && Date.now() - last < PURGE_EVERY_MS) return null
  const result = await runPhotoPurge()
  localStorage.setItem(PURGE_KEY, String(Date.now()))
  return result
}
