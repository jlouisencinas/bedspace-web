import { useState, useLayoutEffect, useRef } from 'react'
import Statement from './Statement'

// Room for two copies on one A4 page (277mm usable less the cut line) in CSS pixels per copy: a taller copy gets a page of its own.
const HALF_PAGE_PX = (135 * 96) / 25.4

// Tenant's and Owner's copy share one A4 page while a copy fits in half a page; a longer copy is never clipped:
// the two copies then go on separate pages.
export default function FinalBillPages({ propsFor, voidText }) {
  const ref = useRef(null)
  const [split, setSplit] = useState(false)
  useLayoutEffect(() => {
    const el = ref.current?.querySelector('.stmt-copy')
    if (!el) return
    const tall = el.offsetHeight > HALF_PAGE_PX + 2
    if (tall !== split) setSplit(tall)
  })
  const banner = voidText && (
    <div style={{ textAlign: 'center', color: '#dc2626', fontWeight: 800, fontSize: 14, marginBottom: 6 }}>{voidText}</div>
  )
  if (split) {
    return (
      <>
        <div className="a4page" ref={ref}>{banner}<Statement {...propsFor("Tenant's Copy")} /></div>
        <div className="a4page">{banner}<Statement {...propsFor("Owner's Copy")} /></div>
      </>
    )
  }
  return (
    <div className="a4page" ref={ref}>
      {banner}
      <Statement {...propsFor("Tenant's Copy")} />
      <div className="cutline" />
      <Statement {...propsFor("Owner's Copy")} />
    </div>
  )
}
