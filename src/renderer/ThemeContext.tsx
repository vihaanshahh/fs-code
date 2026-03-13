import React, { createContext, useContext, useState, useEffect, useMemo, useCallback } from 'react'
import {
  lightTheme,
  darkTheme,
  fonts,
  spacing,
  type ThemeMode,
  type ThemeColors,
} from './theme'

interface ThemeContextValue {
  colors: ThemeColors
  fonts: typeof fonts
  spacing: typeof spacing
  agentColors: readonly string[]
  phaseColorMap: Record<string, string>
  theme: ThemeMode
  setTheme: (mode: ThemeMode) => void
  toggleTheme: () => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeRaw] = useState<ThemeMode>(() => {
    try {
      return (localStorage.getItem('fs-code-theme') as ThemeMode) || 'dark'
    } catch {
      return 'dark'
    }
  })

  const setTheme = useCallback((mode: ThemeMode) => {
    setThemeRaw(mode)
  }, [])

  const toggleTheme = useCallback(() => {
    setThemeRaw(prev => (prev === 'light' ? 'dark' : 'light'))
  }, [])

  // Persist + apply class to html
  useEffect(() => {
    localStorage.setItem('fs-code-theme', theme)
    const html = document.documentElement
    html.classList.toggle('light', theme === 'light')
    html.classList.toggle('dark', theme === 'dark')
    // Update base styles for pre-React content (scrollbars, body)
    document.body.style.background = theme === 'light' ? '#ffffff' : '#1a1a1a'
    document.body.style.color = theme === 'light' ? '#1b1b1b' : '#f9f9f9'
  }, [theme])

  const value = useMemo<ThemeContextValue>(() => {
    const t = theme === 'light' ? lightTheme : darkTheme
    return {
      colors: t.colors,
      fonts: t.fonts,
      spacing: t.spacing,
      agentColors: t.agentColors,
      phaseColorMap: t.phaseColorMap,
      theme,
      setTheme,
      toggleTheme,
    }
  }, [theme, setTheme, toggleTheme])

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider')
  return ctx
}
