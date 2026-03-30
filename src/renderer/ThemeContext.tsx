import React, { createContext, useContext, useState, useEffect, useMemo, useCallback } from 'react'
import {
  themes,
  themeList,
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

const themeIds = themeList.map(t => t.id)

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeRaw] = useState<ThemeMode>(() => {
    try {
      const stored = localStorage.getItem('fs-code-theme') as ThemeMode
      return stored && themes[stored] ? stored : 'dark'
    } catch {
      return 'dark'
    }
  })

  const setTheme = useCallback((mode: ThemeMode) => {
    if (themes[mode]) setThemeRaw(mode)
  }, [])

  const toggleTheme = useCallback(() => {
    setThemeRaw(prev => {
      const idx = themeIds.indexOf(prev)
      return themeIds[(idx + 1) % themeIds.length]
    })
  }, [])

  // Persist + apply class to html
  useEffect(() => {
    localStorage.setItem('fs-code-theme', theme)
    const html = document.documentElement
    // Remove all theme classes, add current
    for (const id of themeIds) html.classList.remove(id)
    html.classList.add(theme)
    // Also set light/dark for any CSS that checks those
    const isDark = theme !== 'light'
    html.classList.toggle('light', !isDark)
    html.classList.toggle('dark', isDark)
    // Update base styles for pre-React content
    const t = themes[theme]
    document.body.style.background = t.colors.bg
    document.body.style.color = t.colors.text
  }, [theme])

  const value = useMemo<ThemeContextValue>(() => {
    const t = themes[theme]
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
