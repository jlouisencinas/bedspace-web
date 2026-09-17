/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'Arial', 'sans-serif'],
      },
      colors: {
        navy: {
          50:  '#FFFBEF',
          100: '#FEF3C7',
          200: '#FDE68A',
          300: '#FCD34D',
          400: '#FBBF24',
          500: '#f4a522',
          600: '#D97706',
          700: '#B45309',
          800: '#92400E',
          900: '#292420',
          950: '#1C1714',
        },
        canvas: 'var(--bg)',
        surface: { DEFAULT: 'var(--surface)', 2: 'var(--surface-2)', 3: 'var(--surface-3)', hover: 'var(--surface-hover)', elevated: 'var(--surface-elevated)' },
        ink: { DEFAULT: 'var(--text-primary)', secondary: 'var(--text-secondary)', muted: 'var(--text-muted)', faint: 'var(--text-faint)', onaccent: 'var(--text-onaccent)' },
        line: { DEFAULT: 'var(--border)', subtle: 'var(--border-lite)' },
        'success-bg': 'var(--success-bg)', 'success-text': 'var(--success-text)', 'success-border': 'var(--success-border)',
        'warning-bg': 'var(--warning-bg)', 'warning-text': 'var(--warning-text)', 'warning-border': 'var(--warning-border)',
        'danger-bg':  'var(--danger-bg)',  'danger-text':  'var(--danger-text)',  'danger-border':  'var(--danger-border)',
        'info-bg':    'var(--info-bg)',    'info-text':    'var(--info-text)',    'info-border':    'var(--info-border)',
        'badge-sky-bg':    'var(--badge-sky-bg)',    'badge-sky-text':    'var(--badge-sky-text)',
        'badge-rose-bg':   'var(--badge-rose-bg)',   'badge-rose-text':   'var(--badge-rose-text)',
        'badge-indigo-bg': 'var(--badge-indigo-bg)', 'badge-indigo-text': 'var(--badge-indigo-text)',
        'badge-violet-bg': 'var(--badge-violet-bg)', 'badge-violet-text': 'var(--badge-violet-text)',
        'badge-teal-bg':   'var(--badge-teal-bg)',   'badge-teal-text':   'var(--badge-teal-text)',
        'badge-purple-bg': 'var(--badge-purple-bg)', 'badge-purple-text': 'var(--badge-purple-text)',
        'badge-orange-bg': 'var(--badge-orange-bg)', 'badge-orange-text': 'var(--badge-orange-text)',
      },
      keyframes: {
        'slide-up': {
          '0%':   { opacity: '0', transform: 'translateY(10px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'fade-in': {
          '0%':   { opacity: '0' },
          '100%': { opacity: '1' },
        },
        'slide-in-left': {
          '0%':   { opacity: '0', transform: 'translateX(-12px)' },
          '100%': { opacity: '1', transform: 'translateX(0)' },
        },
      },
      animation: {
        'slide-up':       'slide-up 0.2s ease-out',
        'fade-in':        'fade-in 0.15s ease-out',
        'slide-in-left':  'slide-in-left 0.18s ease-out',
      },
      boxShadow: {
        card: 'var(--shadow-card)', 'card-lg': 'var(--shadow-card-lg)', modal: 'var(--shadow-modal)',
      },
    },
  },
  plugins: [],
}
