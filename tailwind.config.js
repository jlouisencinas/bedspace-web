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
        'card':    '0 1px 3px rgba(244,165,34,0.08), 0 1px 2px rgba(28,23,20,0.04)',
        'card-lg': '0 4px 16px rgba(244,165,34,0.12), 0 2px 6px rgba(28,23,20,0.06)',
        'modal':   '0 24px 60px rgba(28,23,20,0.20), 0 8px 20px rgba(28,23,20,0.10)',
      },
    },
  },
  plugins: [],
}
