import React from 'react'
import { keyboardShortcuts } from './commands'
import { useTheme } from '../../ThemeContext'

const categoryLabels: Record<string, string> = {
  navigation: 'Navigation',
  agent: 'Agents',
  view: 'View',
}

export default function ShortcutOverlay({ onClose }: { onClose: () => void }) {
  const { colors, fonts } = useTheme()

  const grouped = keyboardShortcuts.reduce<Record<string, typeof keyboardShortcuts>>((acc, s) => {
    (acc[s.category] ||= []).push(s)
    return acc
  }, {})

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: colors.modalOverlay,
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        zIndex: 1000,
        animation: 'modalIn 0.12s ease',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: 420,
          background: colors.bgSurface,
          border: `1px solid ${colors.border}`,
          borderRadius: 12,
          overflow: 'hidden',
          animation: 'paletteIn 0.15s ease',
        }}
      >
        <div style={{
          padding: '14px 20px',
          borderBottom: `1px solid ${colors.border}`,
          fontSize: 14,
          fontWeight: 600,
          color: colors.text,
        }}>
          Keyboard Shortcuts
        </div>

        <div style={{ padding: '12px 20px 20px' }}>
          {Object.entries(grouped).map(([category, shortcuts]) => (
            <div key={category} style={{ marginBottom: 16 }}>
              <div style={{
                fontSize: 10,
                fontWeight: 600,
                color: colors.textMuted,
                textTransform: 'uppercase',
                letterSpacing: 0.5,
                marginBottom: 6,
              }}>
                {categoryLabels[category] || category}
              </div>
              {shortcuts.map(s => (
                <div
                  key={s.keys}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '5px 0',
                  }}
                >
                  <span style={{ fontSize: 12, color: colors.textSecondary }}>
                    {s.description}
                  </span>
                  <span style={{
                    fontSize: 11,
                    fontFamily: fonts.mono,
                    color: colors.textMuted,
                    padding: '2px 8px',
                    background: colors.bgOverlay,
                    borderRadius: 4,
                    border: `1px solid ${colors.border}`,
                  }}>
                    {s.keys}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
