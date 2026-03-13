import React, { useState, useEffect, useRef } from 'react'
import { api } from '../../lib/api'
import { useTheme } from '../../ThemeContext'
import type { SessionInfo } from '../../../shared/types'

function formatTimeAgo(ts: number): string {
  const d = Date.now() - ts
  if (d < 60_000) return 'just now'
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`
  return new Date(ts).toLocaleDateString()
}

export default function SessionPicker({
  cwd,
  onSelect,
  onClose,
}: {
  cwd?: string
  onSelect: (sessionId: string) => void
  onClose: () => void
}) {
  const { colors, fonts } = useTheme()
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [filter, setFilter] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setLoading(true)
    api.listSessions(cwd).then((s: SessionInfo[]) => {
      setSessions(s.sort((a, b) => b.lastModified - a.lastModified))
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [cwd])

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const filtered = sessions.filter(s => {
    if (!filter) return true
    const q = filter.toLowerCase()
    return (
      s.summary?.toLowerCase().includes(q) ||
      s.sessionId.toLowerCase().includes(q) ||
      s.cwd?.toLowerCase().includes(q)
    )
  })

  useEffect(() => {
    setSelectedIndex(0)
  }, [filter])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIndex(i => Math.min(i + 1, filtered.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIndex(i => Math.max(i - 1, 0))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        if (filtered[selectedIndex]) onSelect(filtered[selectedIndex].sessionId)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [filtered, selectedIndex, onSelect, onClose])

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
        paddingTop: 100,
      }}
      onClick={onClose}
    >
      <div
        style={{
          width: 520,
          maxHeight: 440,
          background: colors.bgSurface,
          border: `1px solid ${colors.border}`,
          borderRadius: 12,
          overflow: 'hidden',
          animation: 'paletteIn 0.15s ease',
          display: 'flex',
          flexDirection: 'column',
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* Search input */}
        <div style={{
          padding: '12px 16px',
          borderBottom: `1px solid ${colors.border}`,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}>
          <span style={{ fontSize: 13, color: colors.textMuted }}>Resume</span>
          <input
            ref={inputRef}
            value={filter}
            onChange={e => setFilter(e.target.value)}
            placeholder="Search sessions..."
            style={{
              flex: 1,
              background: 'transparent',
              border: 'none',
              color: colors.text,
              fontSize: 14,
              outline: 'none',
              fontFamily: 'inherit',
            }}
          />
        </div>

        {/* Session list */}
        <div style={{ flex: 1, overflow: 'auto' }}>
          {loading ? (
            <div style={{ padding: 24, textAlign: 'center', color: colors.textMuted, fontSize: 13 }}>
              Loading sessions...
            </div>
          ) : filtered.length === 0 ? (
            <div style={{ padding: 24, textAlign: 'center', color: colors.textMuted, fontSize: 13 }}>
              {sessions.length === 0 ? 'No previous sessions found' : 'No matching sessions'}
            </div>
          ) : (
            filtered.map((session, i) => (
              <div
                key={session.sessionId}
                onClick={() => onSelect(session.sessionId)}
                onMouseEnter={() => setSelectedIndex(i)}
                style={{
                  padding: '10px 16px',
                  cursor: 'pointer',
                  background: i === selectedIndex ? `${colors.blue}15` : 'transparent',
                  borderBottom: `1px solid ${colors.border}22`,
                  transition: 'background 0.1s',
                }}
              >
                <div style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: 2,
                }}>
                  <span style={{
                    fontSize: 13,
                    color: colors.text,
                    fontWeight: 500,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    flex: 1,
                  }}>
                    {session.summary || 'Untitled session'}
                  </span>
                  <span style={{
                    fontSize: 11,
                    color: colors.textMuted,
                    marginLeft: 12,
                    flexShrink: 0,
                  }}>
                    {formatTimeAgo(session.lastModified)}
                  </span>
                </div>
                <div style={{
                  fontSize: 11,
                  color: colors.textMuted,
                  fontFamily: fonts.mono,
                  display: 'flex',
                  gap: 12,
                }}>
                  <span>{session.sessionId.slice(0, 8)}</span>
                  {session.cwd && (
                    <span style={{ opacity: 0.7 }}>
                      {session.cwd.split('/').slice(-2).join('/')}
                    </span>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
