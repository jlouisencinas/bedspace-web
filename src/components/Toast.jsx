import { useState, useCallback, useRef } from 'react'

// useToast returns { show, ToastEl }
export function useToast() {
  const [toast, setToast] = useState(null)
  const timer = useRef(null)

  const show = useCallback((msg, type = 'success') => {
    setToast({ msg, type })
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setToast(null), 3200)
  }, [])

  const ToastEl = toast
    ? <div className={`toast ${toast.type}`}>{toast.msg}</div>
    : null

  return { show, ToastEl }
}
