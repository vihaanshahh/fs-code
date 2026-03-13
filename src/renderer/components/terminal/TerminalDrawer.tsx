import React, { useState, useEffect } from 'react'
import TerminalPanel from './Terminal'
import { useTheme } from '../../ThemeContext'

export default function TerminalDrawer({
  cwd,
  visible,
  onToggle,
}: {
  cwd: string
  visible: boolean
  onToggle: () => void
}) {
  const { colors, spacing, fonts } = useTheme()
  const [height, setHeight] = useState(spacing.terminalDefaultHeight)
  const [resizing, setResizing] = useState(false)

  useEffect(() => {
    if (!resizing) return
    const onMove = (e: MouseEvent) => {
      setHeight(Math.max(80, Math.min(500, window.innerHeight - e.clientY)))
    }
    const onUp = () => setResizing(false)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [resizing])

  if (!visible) return null

  const shortCwd = cwd === '.' ? '~' : '~/' + cwd.split('/').slice(-2).join('/')

  return (
    <div style={{
      height,
      borderTop: `1px solid ${colors.border}`,
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
      flexShrink: 0,
    }}>
      {/* Resize handle */}
      <div
        style={{
          height: 4,
          cursor: 'row-resize',
          background: resizing ? colors.blue : 'transparent',
          transition: 'background 0.1s',
        }}
        onMouseDown={() => setResizing(true)}
        onMouseEnter={e => { if (!resizing) e.currentTarget.style.background = colors.border }}
        onMouseLeave={e => { if (!resizing) e.currentTarget.style.background = 'transparent' }}
      />

      {/* Drawer header */}
      <div style={{
        height: 28,
        padding: '0 12px',
        borderBottom: `1px solid ${colors.border}`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        background: colors.bgOverlay,
        userSelect: 'none',
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5 }}>
            Terminal
          </span>
          <span style={{
            fontSize: 10,
            color: colors.textMuted,
            fontFamily: fonts.mono,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }} title={cwd}>
            {shortCwd}
          </span>
        </div>
        <span
          onClick={onToggle}
          style={{ cursor: 'pointer', fontSize: 11, color: colors.textMuted, fontFamily: fonts.mono }}
          title="Close (Cmd+`)"
        >
          {'\u2715'}
        </span>
      </div>

      {/* Terminal content — key on cwd so it re-creates when agent folder changes */}
      <div style={{ flex: 1, overflow: 'hidden' }}>
        <TerminalPanel key={cwd} cwd={cwd} />
      </div>
    </div>
  )
}
