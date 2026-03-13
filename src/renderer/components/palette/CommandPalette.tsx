import React, { useState, useEffect, useRef } from 'react'
import { paletteCommands } from './commands'
import { useTheme } from '../../ThemeContext'

export default function CommandPalette({
  onAction,
  onClose,
}: {
  onAction: (action: string) => void
  onClose: () => void
}) {
  const { colors, fonts, spacing } = useTheme()
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const filtered = paletteCommands.filter(cmd =>
    cmd.label.toLowerCase().includes(query.toLowerCase()) ||
    cmd.description.toLowerCase().includes(query.toLowerCase())
  )

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    setSelectedIndex(0)
  }, [query])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIndex(i => Math.min(i + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex(i => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (filtered[selectedIndex]) onAction(filtered[selectedIndex].id)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: colors.modalOverlay,
        display: 'flex',
        justifyContent: 'center',
        paddingTop: 100,
        zIndex: 1000,
        animation: 'modalIn 0.12s ease',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: spacing.commandPaletteWidth,
          maxHeight: 360,
          background: colors.bgSurface,
          border: `1px solid ${colors.border}`,
          borderRadius: 12,
          overflow: 'hidden',
          animation: 'paletteIn 0.15s ease',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* Search input */}
        <div style={{
          padding: '12px 16px',
          borderBottom: `1px solid ${colors.border}`,
        }}>
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type a command..."
            style={{
              width: '100%',
              background: 'transparent',
              border: 'none',
              color: colors.text,
              fontSize: 14,
              outline: 'none',
              fontFamily: 'inherit',
            }}
          />
        </div>

        {/* Command list */}
        <div style={{ flex: 1, overflow: 'auto' }}>
          {filtered.map((cmd, i) => (
            <div
              key={cmd.id}
              onClick={() => onAction(cmd.id)}
              onMouseEnter={() => setSelectedIndex(i)}
              style={{
                padding: '10px 16px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                cursor: 'pointer',
                background: i === selectedIndex ? `${colors.blue}12` : 'transparent',
                transition: 'background 0.1s',
              }}
            >
              <div>
                <div style={{ fontSize: 13, color: colors.text, fontWeight: 500 }}>
                  {cmd.label}
                </div>
                <div style={{ fontSize: 11, color: colors.textMuted, marginTop: 1 }}>
                  {cmd.description}
                </div>
              </div>
              {cmd.shortcut && (
                <span style={{
                  fontSize: 11,
                  fontFamily: fonts.mono,
                  color: colors.textMuted,
                  padding: '2px 6px',
                  background: colors.bgOverlay,
                  borderRadius: 4,
                  border: `1px solid ${colors.border}`,
                }}>
                  {cmd.shortcut}
                </span>
              )}
            </div>
          ))}
          {filtered.length === 0 && (
            <div style={{ padding: 20, textAlign: 'center', color: colors.textMuted, fontSize: 13 }}>
              No matching commands
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
