import React, { useState, useRef, useCallback } from 'react'
import AgentCell from './AgentCell'
import FluidBackground from './FluidBackground'
import { useTheme } from '../../ThemeContext'
import type { AgentDescriptor } from '../../../shared/types'

// Draggable divider between panes
function Divider({ direction, onDrag }: {
  direction: 'vertical' | 'horizontal'
  onDrag: (delta: number) => void
}) {
  const { colors } = useTheme()
  const dragging = useRef(false)
  const lastPos = useRef(0)

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    dragging.current = true
    lastPos.current = direction === 'vertical' ? e.clientX : e.clientY

    const onMouseMove = (e: MouseEvent) => {
      if (!dragging.current) return
      const pos = direction === 'vertical' ? e.clientX : e.clientY
      const delta = pos - lastPos.current
      lastPos.current = pos
      onDrag(delta)
    }
    const onMouseUp = () => {
      dragging.current = false
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    document.body.style.cursor = direction === 'vertical' ? 'col-resize' : 'row-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [direction, onDrag])

  const isV = direction === 'vertical'

  return (
    <div
      onMouseDown={onMouseDown}
      style={{
        [isV ? 'width' : 'height']: 5,
        [isV ? 'minWidth' : 'minHeight']: 5,
        cursor: isV ? 'col-resize' : 'row-resize',
        background: colors.bgOverlay,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        zIndex: 2,
      }}
    >
      <div style={{
        [isV ? 'width' : 'height']: 1,
        [isV ? 'height' : 'width']: 32,
        background: colors.borderMuted,
        borderRadius: 1,
        transition: 'background 0.1s',
      }} />
    </div>
  )
}

export default function AgentGrid({
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
  const { colors } = useTheme()
  const containerRef = useRef<HTMLDivElement>(null)
  // Split ratios: percentage of first pane in each split
  const [hSplit, setHSplit] = useState(50) // left/right or top-row/bottom-row
  const [vSplit, setVSplit] = useState(50) // within bottom row for 3 agents, or right col for 4

  const n = agents.length

  const clamp = (v: number) => Math.max(20, Math.min(80, v))

  const handleHDrag = useCallback((delta: number) => {
    const el = containerRef.current
    if (!el) return
    const size = el.getBoundingClientRect().width
    setHSplit(prev => clamp(prev + (delta / size) * 100))
  }, [])

  const handleVDrag = useCallback((delta: number) => {
    const el = containerRef.current
    if (!el) return
    const size = el.getBoundingClientRect().height
    setVSplit(prev => clamp(prev + (delta / size) * 100))
  }, [])

  return (
    <div ref={containerRef} style={{ height: '100%', overflow: 'hidden', position: 'relative' }}>
      {/* 0 agents: welcome state with shader background */}
      {n === 0 && (
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
            {/* Logo + tagline */}
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

            {/* Dock bar */}
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

            {/* Recent folders */}
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
      )}

      {/* 1 agent: full screen */}
      {n === 1 && (
        <div key={1} className="layout-enter" style={{ height: '100%' }}>
          <AgentCell
            descriptor={agents[0]}
            index={0}
            isFocused={true}
            compact={false}
            onFocus={() => onFocus(agents[0].id)}
            onClose={() => onClose(agents[0].id)}
            onSlashCommand={onSlashCommand}
            onRename={onRename}
          />
        </div>
      )}

      {/* 2 agents: vertical split (left | right) */}
      {n === 2 && (
        <div key={2} className="layout-enter" style={{ display: 'flex', height: '100%' }}>
          <div
            style={{ width: `${hSplit}%`, overflow: 'hidden', minWidth: 0 }}
            onDragOver={e => e.preventDefault()}
            onDrop={e => { e.preventDefault(); const from = parseInt(e.dataTransfer.getData('text/plain')); if (from === 1) onReorder(1, 0) }}
          >
            <AgentCell
              descriptor={agents[0]} index={0} isFocused={agents[0].id === focusedId}
              compact onFocus={() => onFocus(agents[0].id)} onClose={() => onClose(agents[0].id)}
              onSlashCommand={onSlashCommand} onRename={onRename} draggable onDragStart={0}
            />
          </div>
          <Divider direction="vertical" onDrag={handleHDrag} />
          <div
            style={{ flex: 1, overflow: 'hidden', minWidth: 0 }}
            onDragOver={e => e.preventDefault()}
            onDrop={e => { e.preventDefault(); const from = parseInt(e.dataTransfer.getData('text/plain')); if (from === 0) onReorder(0, 1) }}
          >
            <AgentCell
              descriptor={agents[1]} index={1} isFocused={agents[1].id === focusedId}
              compact onFocus={() => onFocus(agents[1].id)} onClose={() => onClose(agents[1].id)}
              onSlashCommand={onSlashCommand} onRename={onRename} draggable onDragStart={1}
            />
          </div>
        </div>
      )}

      {/* 3 agents: top full-width | bottom two side-by-side */}
      {n === 3 && (
        <div key={3} className="layout-enter" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
          <div
            style={{ height: `${vSplit}%`, overflow: 'hidden', minHeight: 0 }}
            onDragOver={e => e.preventDefault()}
            onDrop={e => { e.preventDefault(); const from = parseInt(e.dataTransfer.getData('text/plain')); if (from !== 0) onReorder(from, 0) }}
          >
            <AgentCell
              descriptor={agents[0]} index={0} isFocused={agents[0].id === focusedId}
              compact onFocus={() => onFocus(agents[0].id)} onClose={() => onClose(agents[0].id)}
              onSlashCommand={onSlashCommand} onRename={onRename} draggable onDragStart={0}
            />
          </div>
          <Divider direction="horizontal" onDrag={handleVDrag} />
          <div style={{ flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0 }}>
            <div
              style={{ width: `${hSplit}%`, overflow: 'hidden', minWidth: 0 }}
              onDragOver={e => e.preventDefault()}
              onDrop={e => { e.preventDefault(); const from = parseInt(e.dataTransfer.getData('text/plain')); if (from !== 1) onReorder(from, 1) }}
            >
              <AgentCell
                descriptor={agents[1]} index={1} isFocused={agents[1].id === focusedId}
                compact onFocus={() => onFocus(agents[1].id)} onClose={() => onClose(agents[1].id)}
                onSlashCommand={onSlashCommand} onRename={onRename} draggable onDragStart={1}
              />
            </div>
            <Divider direction="vertical" onDrag={handleHDrag} />
            <div
              style={{ flex: 1, overflow: 'hidden', minWidth: 0 }}
              onDragOver={e => e.preventDefault()}
              onDrop={e => { e.preventDefault(); const from = parseInt(e.dataTransfer.getData('text/plain')); if (from !== 2) onReorder(from, 2) }}
            >
              <AgentCell
                descriptor={agents[2]} index={2} isFocused={agents[2].id === focusedId}
                compact onFocus={() => onFocus(agents[2].id)} onClose={() => onClose(agents[2].id)}
                onSlashCommand={onSlashCommand} onRename={onRename} draggable onDragStart={2}
              />
            </div>
          </div>
        </div>
      )}


      {/* 4 agents: 2x2 with both dividers */}
      {n === 4 && (
        <div key={4} className="layout-enter" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
          {/* Top row */}
          <div style={{ height: `${vSplit}%`, display: 'flex', overflow: 'hidden', minHeight: 0 }}>
            <div
              style={{ width: `${hSplit}%`, overflow: 'hidden', minWidth: 0 }}
              onDragOver={e => e.preventDefault()}
              onDrop={e => { e.preventDefault(); const from = parseInt(e.dataTransfer.getData('text/plain')); if (from !== 0) onReorder(from, 0) }}
            >
              <AgentCell
                descriptor={agents[0]} index={0} isFocused={agents[0].id === focusedId}
                compact onFocus={() => onFocus(agents[0].id)} onClose={() => onClose(agents[0].id)}
                onSlashCommand={onSlashCommand} onRename={onRename} draggable onDragStart={0}
              />
            </div>
            <Divider direction="vertical" onDrag={handleHDrag} />
            <div
              style={{ flex: 1, overflow: 'hidden', minWidth: 0 }}
              onDragOver={e => e.preventDefault()}
              onDrop={e => { e.preventDefault(); const from = parseInt(e.dataTransfer.getData('text/plain')); if (from !== 1) onReorder(from, 1) }}
            >
              <AgentCell
                descriptor={agents[1]} index={1} isFocused={agents[1].id === focusedId}
                compact onFocus={() => onFocus(agents[1].id)} onClose={() => onClose(agents[1].id)}
                onSlashCommand={onSlashCommand} onRename={onRename} draggable onDragStart={1}
              />
            </div>
          </div>
          <Divider direction="horizontal" onDrag={handleVDrag} />
          {/* Bottom row */}
          <div style={{ flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0 }}>
            <div
              style={{ width: `${hSplit}%`, overflow: 'hidden', minWidth: 0 }}
              onDragOver={e => e.preventDefault()}
              onDrop={e => { e.preventDefault(); const from = parseInt(e.dataTransfer.getData('text/plain')); if (from !== 2) onReorder(from, 2) }}
            >
              <AgentCell
                descriptor={agents[2]} index={2} isFocused={agents[2].id === focusedId}
                compact onFocus={() => onFocus(agents[2].id)} onClose={() => onClose(agents[2].id)}
                onSlashCommand={onSlashCommand} onRename={onRename} draggable onDragStart={2}
              />
            </div>
            <Divider direction="vertical" onDrag={handleHDrag} />
            <div
              style={{ flex: 1, overflow: 'hidden', minWidth: 0 }}
              onDragOver={e => e.preventDefault()}
              onDrop={e => { e.preventDefault(); const from = parseInt(e.dataTransfer.getData('text/plain')); if (from !== 3) onReorder(from, 3) }}
            >
              <AgentCell
                descriptor={agents[3]} index={3} isFocused={agents[3].id === focusedId}
                compact onFocus={() => onFocus(agents[3].id)} onClose={() => onClose(agents[3].id)}
                onSlashCommand={onSlashCommand} onRename={onRename} draggable onDragStart={3}
              />
            </div>
          </div>
        </div>
      )}

      {/* 5-9 agents: 3-column CSS grid */}
      {n >= 5 && (() => {
        const rows = Math.ceil(n / 3)
        return (
          <div key={n} className="layout-enter" style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 1fr)',
            gridTemplateRows: `repeat(${rows}, 1fr)`,
            height: '100%',
            gap: 1,
            background: colors.border,
          }}>
            {agents.map((agent, i) => (
              <div
                key={agent.id}
                style={{
                  overflow: 'hidden',
                  minWidth: 0,
                  minHeight: 0,
                  background: colors.bg,
                  // Last row: if fewer than 3 items, let them fill naturally
                  ...(i >= n - (n % 3 || 3) && n % 3 !== 0 ? {} : {}),
                }}
                onDragOver={e => e.preventDefault()}
                onDrop={e => {
                  e.preventDefault()
                  const from = parseInt(e.dataTransfer.getData('text/plain'))
                  if (from !== i) onReorder(from, i)
                }}
              >
                <AgentCell
                  descriptor={agent}
                  index={i}
                  isFocused={agent.id === focusedId}
                  compact
                  onFocus={() => onFocus(agent.id)}
                  onClose={() => onClose(agent.id)}
                  onSlashCommand={onSlashCommand}
                  onRename={onRename}
                  draggable
                  onDragStart={i}
                />
              </div>
            ))}
          </div>
        )
      })()}

    </div>
  )
}
