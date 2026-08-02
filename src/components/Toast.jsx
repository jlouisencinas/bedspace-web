import { useState, useCallback, useEffect, useRef } from 'react'
import { CheckCircle, XCircle, X } from 'lucide-react'

export function useToast() {
  const [toasts, setToasts] = useState([])
  const counter = useRef(0)

  const show = useCallback((msg, type = 'success') => {
    const id = ++counter.current
    setToasts(t => [...t, { id, msg, type }])
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 3500)
  }, [])

  const dismiss = useCallback((id) => {
    setToasts(t => t.filter(x => x.id !== id))
  }, [])

  const ToastEl = (
    <div className="fixed bottom-6 right-6 z-[9999] flex flex-col gap-2 pointer-events-none">
      {toasts.map(toast => (
        <ToastItem key={toast.id} toast={toast} onDismiss={() => dismiss(toast.id)} />
      ))}
    </div>
  )

  return { show, ToastEl }
}

function ToastItem({ toast, onDismiss }) {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    requestAnimationFrame(() => setVisible(true))
  }, [])

  const isSuccess = toast.type === 'success'
  const Icon = isSuccess ? CheckCircle : XCircle

  return (
    <div
      className={`pointer-events-auto flex items-center gap-3 px-4 py-3 rounded-xl shadow-modal
                  bg-slate-900 text-white text-[13px] font-medium max-w-[320px]
                  border-l-4 transition-all duration-300
                  ${isSuccess ? 'border-emerald-500' : 'border-red-500'}
                  ${visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-3'}`}
    >
      <Icon size={16} className={isSuccess ? 'text-emerald-400 shrink-0' : 'text-red-400 shrink-0'} />
      <span className="flex-1">{toast.msg}</span>
      <button
        onClick={onDismiss}
        className="p-0.5 rounded hover:bg-white/10 text-white/50 hover:text-white/80 transition-colors"
      >
        <X size={13} />
      </button>
    </div>
  )
}
