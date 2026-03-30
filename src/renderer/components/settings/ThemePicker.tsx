import React, { useState, useRef, useEffect } from 'react'
import { useTheme } from '../../ThemeContext'
import { themeList, type ThemeMode } from '../../theme'

export default function ThemePicker() {
  const { colors, fonts, theme, setTheme } = useTheme()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // Close on outside click
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const current = themeList.find(t => t.id === theme)!

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <span
        style={{
          cursor: 'pointer',
          fontSize: 11,
          fontFamily: fonts.ui,
          color: open ? colors.text : colors.textMuted,
          display: 'flex',
          alignItems: 'center',
          gap: 5,
          transition: 'color 0.15s',
          userSelect: 'none',
        }}
        onClick={() => setOpen(v => !v)}
        title="Change theme"
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: current.swatch,
            border: `1px solid ${colors.border}`,
            flexShrink: 0,
          }}
        />
        {current.label}
      </span>

      {open && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            right: 0,
            marginTop: 6,
            background: colors.bgSurface,
            border: `1px solid ${colors.border}`,
            borderRadius: 8,
            padding: 4,
            minWidth: 160,
            zIndex: 9999,
            boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
          }}
        >
          {themeList.map(t => {
            const active = t.id === theme
            return (
              <div
                key={t.id}
                onClick={() => { setTheme(t.id as ThemeMode); setOpen(false) }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '6px 10px',
                  borderRadius: 6,
                  cursor: 'pointer',
                  background: active ? colors.border : 'transparent',
                  transition: 'background 0.12s',
                  fontFamily: fonts.ui,
                  fontSize: 12,
                }}
                onMouseEnter={e => {
                  if (!active) (e.currentTarget as HTMLElement).style.background = colors.borderMuted
                }}
                onMouseLeave={e => {
                  if (!active) (e.currentTarget as HTMLElement).style.background = 'transparent'
                }}
              >
                <span
                  style={{
                    width: 12,
                    height: 12,
                    borderRadius: '50%',
                    background: t.swatch,
                    border: `1.5px solid ${active ? colors.text : colors.border}`,
                    flexShrink: 0,
                  }}
                />
                <div style={{ flex: 1 }}>
                  <div style={{ color: colors.text, fontWeight: active ? 600 : 400 }}>
                    {t.label}
                  </div>
                  <div style={{ color: colors.textMuted, fontSize: 10 }}>
                    {t.description}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
