import { createContext, useContext, useState } from 'react'

const ThemeCtx = createContext(null)
export const useTheme = () => useContext(ThemeCtx)

/**
 * Tracks the active theme ('light' | 'dark'), persisted per browser.
 * Initial value is read from the DOM attribute the FOUC-prevention inline
 * script (index.html) already set before React mounts — don't re-derive it
 * here, or the first render could momentarily disagree with that script.
 */
export function ThemeProvider({ children }) {
  const [theme, setTheme] = useState(
    () => document.documentElement.getAttribute('data-theme') || 'light'
  )

  const toggleTheme = () => {
    setTheme(prev => {
      const next = prev === 'dark' ? 'light' : 'dark'
      localStorage.setItem('bedspace-theme', next)
      document.documentElement.setAttribute('data-theme', next)
      return next
    })
  }

  const value = { theme, isDark: theme === 'dark', toggleTheme }
  return <ThemeCtx.Provider value={value}>{children}</ThemeCtx.Provider>
}
