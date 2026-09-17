import { Search } from 'lucide-react'

export default function SearchInput({ value, onChange, placeholder, className = '', ...rest }) {
  return (
    <div className="relative">
      <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint pointer-events-none" />
      <input
        type="search"
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        className={`pl-9 pr-3 py-2 rounded-lg text-[13px] bg-surface focus:outline-none focus:ring-2 focus:ring-navy-700/25 focus:border-navy-600 transition-colors ${className}`}
        style={{ border: '1px solid var(--border)' }}
        {...rest}
      />
    </div>
  )
}
