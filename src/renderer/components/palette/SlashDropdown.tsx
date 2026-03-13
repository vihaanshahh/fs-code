import React, { useState, useEffect, useRef } from 'react'
import { slashCommands } from './commands'
import { useTheme } from '../../ThemeContext'

export default function SlashDropdown({
  filter,
  onSelect,
  onClose,
}: {
  filter: string
  onSelect: (command: string) => void
  onClose: () => void
}) {
  const { colors, fonts } = useTheme()
  const [selectedIndex, setSelectedIndex] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  const query = filter.slice(1).toLowerCase()
  const filtered = slashCommands.filter(cmd => {
    if (cmd.command.startsWith(filter)) return true
    if (cmd.description.toLowerCase().includes(query)) return true
    if (cmd.aliases?.some(a => a.startsWith(filter))) return true
    return false
  })

  useEffect(() => {
    setSelectedIndex(0)
  }, [filter])

  // Scroll selected item into view
  useEffect(() => {
    const el = listRef.current?.children[selectedIndex] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIndex(i => Math.min(i + 1, filtered.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIndex(i => Math.max(i - 1, 0))
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        if (filtered[selectedIndex]) onSelect(filtered[selectedIndex].command)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [filtered, selectedIndex, onSelect, onClose])

  if (filtered.length === 0) return null

  const categoryColors: Record<string, string> = {
    session: colors.blue,
    agent: colors.green,
    view: colors.purple || colors.blue,
    config: colors.amber,
    history: colors.cyan || colors.blue,
    info: colors.textSecondary,
    misc: colors.textMuted,
  }

  return (
    <div
      ref={listRef}
      style={{
        position: 'absolute',
        bottom: '100%',
        left: 0,
        right: 0,
        marginBottom: 4,
        background: colors.bgSurface,
        border: `1px solid ${colors.border}`,
        borderRadius: 8,
        overflow: 'hidden',
        animation: 'paletteIn 0.12s ease',
        zIndex: 100,
        maxHeight: 280,
        overflowY: 'auto',
      }}
    >
      {filtered.map((cmd, i) => (
        <div
          key={cmd.command}
          onClick={() => onSelect(cmd.command)}
          style={{
            padding: '7px 12px',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            cursor: 'pointer',
            background: i === selectedIndex ? `${colors.blue}15` : 'transparent',
            transition: 'background 0.1s',
          }}
          onMouseEnter={() => setSelectedIndex(i)}
        >
          <span style={{
            fontFamily: fonts.mono,
            fontSize: 12,
            color: colors.blue,
            fontWeight: 600,
            minWidth: 100,
          }}>
            {cmd.command}
          </span>
          <span style={{ fontSize: 12, color: colors.textSecondary, flex: 1 }}>
            {cmd.description}
          </span>
          <span style={{
            fontSize: 9,
            color: categoryColors[cmd.category] || colors.textMuted,
            textTransform: 'uppercase',
            letterSpacing: 0.5,
            fontWeight: 600,
            opacity: 0.6,
          }}>
            {cmd.category}
          </span>
        </div>
      ))}
    </div>
  )
}
