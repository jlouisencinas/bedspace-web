export default function BrandIcon({ size = 28, className = '' }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 28 28"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <rect width="28" height="28" rx="7" fill="currentColor" />
      <rect x="7" y="8.5" width="14" height="3.5" rx="1.5" fill="white" />
      <rect x="7" y="16" width="14" height="3.5" rx="1.5" fill="white" />
    </svg>
  )
}
