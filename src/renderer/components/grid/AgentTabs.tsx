import React, { useState, useRef, useCallback } from 'react'
import TerminalPanel from '../terminal/Terminal'
import FluidBackground from './FluidBackground'
import { useAgent } from '../../hooks/useAgent'
import { useJourneyPhase } from '../../hooks/useJourneyPhase'
import { useTheme } from '../../ThemeContext'
import type { AgentDescriptor } from '../../../shared/types'

/** Live status badge for an agent tab — shows phase + detail */
function TabStatus({ agentId, accentColor, isFocusedTab }: { agentId: string; accentColor: string; isFocusedTab: boolean }) {
  const { colors } = useTheme()
  const agent = useAgent(agentId)
  const phase = useJourneyPhase(agent.messages, agent.isActive, null)

  // Idle / no activity — just show the dot
  if (phase.phase === 'idle') {
    return (
      <span style={{
        width: 7,
        height: 7,
        borderRadius: '50%',
        background: agent.isActive ? accentColor : undefined,
        border: agent.isActive ? 'none' : `1.5px solid ${accentColor}`,
        flexShrink: 0,
        transition: 'background 0.2s',
      }} />
    )
  }

  // Active phase — show colored badge with label
  return (
    <span
      title={phase.detail || phase.label}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 3,
        fontSize: 8,
        fontWeight: 600,
        padding: '1px 5px',
        borderRadius: 6,
        background: `${phase.color}15`,
        color: phase.color,
        whiteSpace: 'nowrap',
        flexShrink: 0,
        letterSpacing: '0.2px',
        textTransform: 'uppercase',
      }}
    >
      <span style={{
        width: 5,
        height: 5,
        borderRadius: '50%',
        background: phase.color,
        flexShrink: 0,
        ...(phase.phase !== 'done' && phase.phase !== 'stuck' ? { animation: 'pulse 1.5s infinite' } : {}),
      }} />
      {phase.label}
    </span>
  )
}

export default function AgentTabs({
  agents,
  focusedId,
  canAddAgent,
  onFocus,
  onClose,
  onAddAgent,
  onSlashCommand,
  onReorder,
  onRename,
  recentFolders = [],
  onOpenRecent,
}: {
  agents: AgentDescriptor[]
  focusedId: string | null
  canAddAgent: boolean
  onFocus: (id: string) => void
  onClose: (id: string) => void
  onAddAgent: () => void
  onSlashCommand: (cmd: string) => void
  onReorder: (fromIndex: number, toIndex: number) => void
  onRename: (id: string, name: string) => void
  recentFolders?: { path: string; name: string }[]
  onOpenRecent?: (path: string) => void
}) {
  const { colors, fonts, agentColors } = useTheme()
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)

  const n = agents.length

  // ── Welcome state (0 agents) ──
  if (n === 0) {
    return (
      <div style={{ height: '100%', position: 'relative', overflow: 'hidden' }}>
        <FluidBackground />
        <div style={{
          position: 'relative',
          zIndex: 1,
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: 'column',
          gap: 32,
        }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{
              fontSize: 28,
              fontWeight: 300,
              color: colors.text,
              letterSpacing: '-0.5px',
              marginBottom: 6,
            }}>
              Fluid State AI
            </div>
            <div style={{ fontSize: 13, color: colors.text, letterSpacing: '0.5px', fontWeight: 300 }}>
              Multi-agent IDE
            </div>
          </div>

          <div style={{
            display: 'flex',
            gap: 2,
            padding: '6px 8px',
            background: `${colors.bgSurface}cc`,
            backdropFilter: 'blur(20px)',
            WebkitBackdropFilter: 'blur(20px)',
            border: `1px solid ${colors.borderMuted}`,
            borderRadius: 16,
          }}>
            {[
              { label: 'New Project', icon: '+', action: onAddAgent, primary: true },
              { label: 'Terminal', icon: '$_', action: () => onSlashCommand('/terminal') },
              { label: 'Theme', icon: '\u25D0', action: () => onSlashCommand('/theme') },
              { label: 'Shortcuts', icon: '?', action: () => onSlashCommand('/help') },
            ].map((item) => (
              <div
                key={item.label}
                onClick={item.action}
                title={item.label}
                style={{
                  width: 48,
                  height: 48,
                  borderRadius: 12,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: 'pointer',
                  transition: 'background 0.15s ease',
                  gap: 3,
                }}
                onMouseEnter={e => {
                  e.currentTarget.style.background = item.primary ? `${colors.blue}15` : `${colors.textMuted}10`
                }}
                onMouseLeave={e => {
                  e.currentTarget.style.background = 'transparent'
                }}
              >
                <span style={{
                  fontSize: item.primary ? 22 : 14,
                  color: item.primary ? colors.blue : colors.textSecondary,
                  lineHeight: 1,
                  fontWeight: item.primary ? 300 : 400,
                }}>
                  {item.icon}
                </span>
                <span style={{ fontSize: 8, color: colors.textMuted, letterSpacing: '0.3px' }}>
                  {item.label.split(' ').pop()}
                </span>
              </div>
            ))}
          </div>

          <div style={{ fontSize: 11, color: colors.textMuted, opacity: 0.5 }}>
            Cmd+N to start
          </div>

          {recentFolders.length > 0 && onOpenRecent && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center', maxWidth: 480 }}>
              {recentFolders.slice(0, 3).map(f => (
                <div
                  key={f.path}
                  onClick={() => onOpenRecent(f.path)}
                  title={f.path}
                  style={{
                    padding: '5px 12px',
                    borderRadius: 10,
                    fontSize: 11,
                    color: colors.textSecondary,
                    background: `${colors.bgSurface}aa`,
                    border: `1px solid ${colors.borderMuted}`,
                    cursor: 'pointer',
                    transition: 'all 0.15s ease',
                    maxWidth: 180,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap' as const,
                  }}
                  onMouseEnter={e => {
                    e.currentTarget.style.background = `${colors.blue}12`
                    e.currentTarget.style.borderColor = `${colors.blue}40`
                    e.currentTarget.style.color = colors.text
                  }}
                  onMouseLeave={e => {
                    e.currentTarget.style.background = `${colors.bgSurface}aa`
                    e.currentTarget.style.borderColor = colors.borderMuted
                    e.currentTarget.style.color = colors.textSecondary
                  }}
                >
                  {f.path.replace(/^\/Users\/[^/]+/, '~')}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    )
  }

  // ── Tab layout ──
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Tab bar */}
      <div style={{
        height: 36,
        display: 'flex',
        alignItems: 'stretch',
        background: colors.bgOverlay,
        borderBottom: `1px solid ${colors.border}`,
        flexShrink: 0,
        overflowX: 'auto',
        overflowY: 'hidden',
        userSelect: 'none',
      }}>
        {agents.map((agent, i) => {
          const accentColor = agentColors[i % agentColors.length]
          const isActive = agent.id === focusedId
          const isDragOver = dragOverIndex === i

          return (
            <div
              key={agent.id}
              draggable
              onDragStart={e => {
                e.dataTransfer.setData('text/plain', String(i))
                e.dataTransfer.effectAllowed = 'move'
              }}
              onDragOver={e => {
                e.preventDefault()
                setDragOverIndex(i)
              }}
              onDragLeave={() => setDragOverIndex(null)}
              onDrop={e => {
                e.preventDefault()
                setDragOverIndex(null)
                const from = parseInt(e.dataTransfer.getData('text/plain'))
                if (from !== i) onReorder(from, i)
              }}
              onClick={() => onFocus(agent.id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '0 12px',
                cursor: 'pointer',
                borderBottom: isActive ? `2px solid ${accentColor}` : '2px solid transparent',
                borderLeft: isDragOver ? `2px solid ${accentColor}` : '2px solid transparent',
                background: isActive ? `${accentColor}08` : 'transparent',
                transition: 'background 0.12s ease, border-color 0.12s ease',
                flexShrink: 0,
                maxWidth: 200,
                minWidth: 0,
              }}
              onMouseEnter={e => {
                if (!isActive) e.currentTarget.style.background = `${colors.textMuted}08`
              }}
              onMouseLeave={e => {
                if (!isActive) e.currentTarget.style.background = 'transparent'
              }}
            >
              <TabStatus agentId={agent.id} accentColor={accentColor} isFocusedTab={isActive} />

              {editingId === agent.id ? (
                <input
                  autoFocus
                  spellCheck={false}
                  maxLength={8}
                  value={editValue}
                  onChange={e => { if (e.target.value.length <= 8) setEditValue(e.target.value) }}
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      e.stopPropagation()
                      const v = editValue.trim()
                      if (v) onRename(agent.id, v)
                      setEditingId(null)
                    }
                    if (e.key === 'Escape') { e.stopPropagation(); setEditingId(null) }
                  }}
                  onBlur={() => {
                    const v = editValue.trim()
                    if (v) onRename(agent.id, v)
                    setEditingId(null)
                  }}
                  onClick={e => e.stopPropagation()}
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    color: colors.text,
                    background: `${accentColor}12`,
                    border: `1px solid ${accentColor}40`,
                    borderRadius: 3,
                    outline: 'none',
                    padding: '0 4px',
                    width: 56,
                    fontFamily: 'inherit',
                  }}
                />
              ) : (
                <span
                  onDoubleClick={e => {
                    e.stopPropagation()
                    setEditValue(agent.name)
                    setEditingId(agent.id)
                  }}
                  title={`${agent.name} — ${agent.cwd}\nDouble-click to rename`}
                  style={{
                    fontSize: 11,
                    fontWeight: isActive ? 600 : 400,
                    color: isActive ? colors.text : colors.textMuted,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {agent.name}
                </span>
              )}

              {/* CWD hint */}
              <span style={{
                fontSize: 9,
                color: colors.textMuted,
                fontFamily: fonts.mono,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                opacity: 0.6,
                flex: 1,
                minWidth: 0,
              }}>
                {agent.cwd === '.' ? '~' : agent.cwd.split('/').pop()}
              </span>

              {/* Close */}
              <span
                onClick={e => { e.stopPropagation(); onClose(agent.id) }}
                style={{
                  fontSize: 13,
                  color: colors.textMuted,
                  cursor: 'pointer',
                  lineHeight: 1,
                  padding: '0 1px',
                  opacity: 0.6,
                  flexShrink: 0,
                }}
                onMouseEnter={e => { e.currentTarget.style.opacity = '1'; e.currentTarget.style.color = colors.text }}
                onMouseLeave={e => { e.currentTarget.style.opacity = '0.6'; e.currentTarget.style.color = colors.textMuted }}
              >
                ×
              </span>
            </div>
          )
        })}

        {/* Add tab button */}
        {canAddAgent && (
          <div
            onClick={onAddAgent}
            title="New Agent (Cmd+N)"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 32,
              cursor: 'pointer',
              color: colors.textMuted,
              fontSize: 16,
              flexShrink: 0,
              transition: 'color 0.12s ease',
            }}
            onMouseEnter={e => { e.currentTarget.style.color = colors.text }}
            onMouseLeave={e => { e.currentTarget.style.color = colors.textMuted }}
          >
            +
          </div>
        )}
      </div>

      {/* Agent body — all agents mounted, only focused visible */}
      <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
        {agents.map((agent) => (
          <div
            key={agent.id}
            style={{
              position: 'absolute',
              inset: 0,
              display: agent.id === focusedId ? 'flex' : 'none',
              flexDirection: 'column',
            }}
          >
            <TerminalPanel
              agentId={agent.id}
              cwd={agent.cwd}
              mode="claude"
            />
          </div>
        ))}
      </div>
    </div>
  )
}
