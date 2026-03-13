import React, { useEffect } from 'react'
import { slashCommands } from './commands'
import { useTheme } from '../../ThemeContext'

const categoryLabels: Record<string, string> = {
  session: 'Session',
  history: 'History',
  agent: 'Agent',
  view: 'View',
  config: 'Config',
  info: 'Info',
  misc: 'Misc',
}

const categoryOrder = ['session', 'history', 'agent', 'view', 'config', 'info', 'misc']

export default function HelpOverlay({ onClose }: { onClose: () => void }) {
  const { colors, fonts } = useTheme()

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose() }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const grouped = new Map<string, typeof slashCommands>()
  for (const cmd of slashCommands) {
    const list = grouped.get(cmd.category) || []
    list.push(cmd)
    grouped.set(cmd.category, list)
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 2000,
        background: `${colors.bg}cc`,
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: 60,
      }}
      onClick={onClose}
    >
      <div
        style={{
          width: 600,
          maxHeight: 'calc(100vh - 120px)',
          background: colors.bgSurface,
          border: `1px solid ${colors.border}`,
          borderRadius: 12,
          overflow: 'auto',
          animation: 'paletteIn 0.15s ease',
          padding: '20px 24px',
        }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 16,
        }}>
          <span style={{ fontSize: 16, fontWeight: 700, color: colors.text }}>
            Commands
          </span>
          <span
            onClick={onClose}
            style={{ cursor: 'pointer', color: colors.textMuted, fontSize: 13 }}
          >
            Esc
          </span>
        </div>

        {categoryOrder.map(cat => {
          const cmds = grouped.get(cat)
          if (!cmds || cmds.length === 0) return null
          return (
            <div key={cat} style={{ marginBottom: 16 }}>
              <div style={{
                fontSize: 11,
                fontWeight: 700,
                color: colors.textMuted,
                textTransform: 'uppercase',
                letterSpacing: 0.8,
                marginBottom: 6,
              }}>
                {categoryLabels[cat] || cat}
              </div>
              <div style={{
                display: 'grid',
                gridTemplateColumns: '1fr 1fr',
                gap: '2px 16px',
              }}>
                {cmds.map(cmd => (
                  <div key={cmd.command} style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '3px 0',
                  }}>
                    <span style={{
                      fontFamily: fonts.mono,
                      fontSize: 12,
                      color: colors.blue,
                      fontWeight: 600,
                      minWidth: 110,
                    }}>
                      {cmd.command}
                    </span>
                    <span style={{ fontSize: 12, color: colors.textSecondary }}>
                      {cmd.description}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
