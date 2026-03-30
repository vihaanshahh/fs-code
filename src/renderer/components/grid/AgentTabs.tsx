import React, { useState, useCallback } from 'react'
import TerminalPanel from '../terminal/Terminal'
import FluidBackground from './FluidBackground'
import { useAgent } from '../../hooks/useAgent'
import { useJourneyPhase } from '../../hooks/useJourneyPhase'
import { useTheme } from '../../ThemeContext'
import type { AgentDescriptor } from '../../../shared/types'

const TAB_SIDEBAR_KEY = 'fs-code-tab-sidebar-width'
const TAB_SIDEBAR_COLLAPSED_KEY = 'fs-code-tab-sidebar-collapsed'
const DEFAULT_SIDEBAR_WIDTH = 180
const MIN_SIDEBAR_WIDTH = 120
const MAX_SIDEBAR_WIDTH = 320

function clampWidth(v: number): number {
  return Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, v))
}

function loadSidebarWidth(): number {
  try {
    const raw = localStorage.getItem(TAB_SIDEBAR_KEY)
    if (raw == null) return DEFAULT_SIDEBAR_WIDTH
    const parsed = Number(raw)
    if (!Number.isFinite(parsed)) return DEFAULT_SIDEBAR_WIDTH
    return clampWidth(parsed)
  } catch {
    return DEFAULT_SIDEBAR_WIDTH
  }
}

function saveSidebarWidth(width: number): void {
  try { localStorage.setItem(TAB_SIDEBAR_KEY, String(width)) } catch { /* quota */ }
}

function loadSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(TAB_SIDEBAR_COLLAPSED_KEY) === 'true'
  } catch { return false }
}

function saveSidebarCollapsed(collapsed: boolean): void {
  try { localStorage.setItem(TAB_SIDEBAR_COLLAPSED_KEY, String(collapsed)) } catch { /* quota */ }
}

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
  const [sidebarWidth, setSidebarWidthRaw] = useState(loadSidebarWidth)
  const [sidebarCollapsed, setSidebarCollapsedRaw] = useState(loadSidebarCollapsed)
  const [isResizing, setIsResizing] = useState(false)

  const setSidebarWidth = useCallback((width: number) => {
    const clamped = clampWidth(width)
    setSidebarWidthRaw(clamped)
    saveSidebarWidth(clamped)
  }, [])

  const setSidebarCollapsed = useCallback((collapsed: boolean) => {
    setSidebarCollapsedRaw(collapsed)
    saveSidebarCollapsed(collapsed)
  }, [])

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setIsResizing(true)
    const startX = e.clientX
    const startWidth = sidebarWidth
    let active = true

    const onMouseMove = (e: MouseEvent) => {
      if (!active) return
      const delta = e.clientX - startX
      const newWidth = clampWidth(startWidth + delta)
      setSidebarWidthRaw(newWidth)
    }
    const onMouseUp = () => {
      active = false
      setIsResizing(false)
      // Persist final width
      setSidebarWidthRaw(prev => { saveSidebarWidth(prev); return prev })
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [sidebarWidth])

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

  // ── Left sidebar tab layout ──
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'row', overflow: 'hidden' }}>
      {/* Left tab sidebar */}
      <div style={{
        width: sidebarCollapsed ? 36 : sidebarWidth,
        display: 'flex',
        flexDirection: 'column',
        background: colors.bgOverlay,
        borderRight: `1px solid ${colors.border}`,
        flexShrink: 0,
        overflow: 'hidden',
        transition: isResizing ? 'none' : 'width 0.15s ease',
        userSelect: 'none',
      }}>
        {sidebarCollapsed ? (
          /* Collapsed state — vertical label */
          <div
            onClick={() => setSidebarCollapsed(false)}
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              writingMode: 'vertical-rl',
              fontSize: 11,
              color: colors.textMuted,
              letterSpacing: 1,
            }}
          >
            Agents ({n})
          </div>
        ) : (
          <>
            {/* Sidebar header */}
            <div style={{
              height: 32,
              display: 'flex',
              alignItems: 'center',
              padding: '0 8px',
              flexShrink: 0,
              borderBottom: `1px solid ${colors.border}`,
              gap: 4,
            }}>
              <span style={{ fontSize: 10, fontWeight: 600, color: colors.textMuted, letterSpacing: '0.5px', textTransform: 'uppercase', flex: 1 }}>
                Agents
              </span>
              <span
                onClick={() => setSidebarCollapsed(true)}
                style={{ cursor: 'pointer', fontSize: 14, color: colors.textMuted, lineHeight: 1, padding: '0 2px' }}
                title="Collapse sidebar"
              >
                {'\u00AB'}
              </span>
            </div>

            {/* Tab list */}
            <div style={{
              flex: 1,
              overflowY: 'auto',
              overflowX: 'hidden',
              padding: '4px 0',
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
                      padding: '6px 8px',
                      margin: '0 4px',
                      borderRadius: 6,
                      cursor: 'pointer',
                      borderLeft: `2px solid ${isActive ? accentColor : 'transparent'}`,
                      borderTop: isDragOver ? `2px solid ${accentColor}` : '2px solid transparent',
                      background: isActive ? `${accentColor}10` : 'transparent',
                      transition: 'background 0.12s ease, border-color 0.12s ease',
                      minHeight: 32,
                    }}
                    onMouseEnter={e => {
                      if (!isActive) e.currentTarget.style.background = `${colors.textMuted}08`
                    }}
                    onMouseLeave={e => {
                      if (!isActive) e.currentTarget.style.background = 'transparent'
                    }}
                  >
                    <TabStatus agentId={agent.id} accentColor={accentColor} isFocusedTab={isActive} />

                    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
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
                            width: '100%',
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
                      }}>
                        {agent.cwd === '.' ? '~' : agent.cwd.split('/').pop()}
                      </span>
                    </div>

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
            </div>

            {/* Add tab button */}
            {canAddAgent && (
              <div
                onClick={onAddAgent}
                title="New Agent (Cmd+N)"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 4,
                  height: 32,
                  cursor: 'pointer',
                  color: colors.textMuted,
                  fontSize: 11,
                  flexShrink: 0,
                  borderTop: `1px solid ${colors.border}`,
                  transition: 'color 0.12s ease, background 0.12s ease',
                }}
                onMouseEnter={e => { e.currentTarget.style.color = colors.text; e.currentTarget.style.background = `${colors.textMuted}08` }}
                onMouseLeave={e => { e.currentTarget.style.color = colors.textMuted; e.currentTarget.style.background = 'transparent' }}
              >
                <span style={{ fontSize: 14 }}>+</span>
                New Agent
              </div>
            )}
          </>
        )}
      </div>

      {/* Resize handle */}
      {!sidebarCollapsed && (
        <div
          onMouseDown={handleResizeStart}
          style={{
            width: 5,
            cursor: 'col-resize',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
            zIndex: 2,
          }}
        >
          <div style={{
            width: 1,
            height: 32,
            background: colors.borderMuted,
            borderRadius: 1,
            transition: 'background 0.1s',
          }} />
        </div>
      )}

      {/* Agent body — all agents mounted, only focused visible */}
      <div style={{ flex: 1, overflow: 'hidden', position: 'relative', minWidth: 0 }}>
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
