import React, { useState, useEffect } from 'react'
import TerminalPanel from './Terminal'
import { useTheme } from '../../ThemeContext'

export default function TerminalDrawer({
  agentId,
  cwd,
  visible,
  onToggle,
}: {
  agentId: string
  cwd: string
  visible: boolean
  onToggle: () => void
}) {
  const { colors, spacing, fonts } = useTheme()
  const [height, setHeight] = useState(spacing.terminalDefaultHeight)
  const [resizing, setResizing] = useState(false)
  const [minimized, setMinimized] = useState(false)

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

  const shortCwd = !cwd || cwd === '.' ? '~' : '~/' + cwd.split('/').slice(-2).join('/')

  return (
    <div style={{
      height: minimized ? 33 : height,
      borderTop: `1px solid ${colors.border}`,
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
      flexShrink: 0,
      transition: minimized ? 'height 0.15s ease-out' : undefined,
    }}>
      {/* Resize handle — hidden when minimized */}
      {!minimized && (
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
      )}

      {/* Drawer header */}
      <div
        style={{
          height: 28,
          padding: '0 12px',
          borderBottom: minimized ? undefined : `1px solid ${colors.border}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          background: colors.bgOverlay,
          userSelect: 'none',
          flexShrink: 0,
          cursor: minimized ? 'pointer' : undefined,
        }}
        onDoubleClick={() => setMinimized(m => !m)}
        onClick={minimized ? () => setMinimized(false) : undefined}
      >
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
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {/* Minimize / restore button */}
          <span
            onClick={e => { e.stopPropagation(); setMinimized(m => !m) }}
            style={{ cursor: 'pointer', fontSize: 10, color: colors.textMuted, fontFamily: fonts.mono, lineHeight: 1 }}
            title={minimized ? 'Restore terminal' : 'Minimize terminal'}
          >
            {minimized ? '\u25B2' : '\u25BC'}
          </span>
          {/* Close button */}
          <span
            onClick={e => { e.stopPropagation(); onToggle() }}
            style={{ cursor: 'pointer', fontSize: 11, color: colors.textMuted, fontFamily: fonts.mono }}
            title="Close (Cmd+`)"
          >
            {'\u2715'}
          </span>
        </div>
      </div>

      {/* Terminal content — hidden when minimized */}
      {!minimized && (
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <TerminalPanel agentId={agentId} cwd={cwd} />
        </div>
      )}
    </div>
  )
}
