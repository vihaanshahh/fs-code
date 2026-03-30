import React, { useCallback, useState, useRef } from 'react'
import TerminalPanel from '../terminal/Terminal'
import { useAgent } from '../../hooks/useAgent'
import { useTheme } from '../../ThemeContext'
import type { AgentDescriptor } from '../../../shared/types'

export default function AgentCell({
  descriptor,
  index,
  isFocused,
  compact,
  onFocus,
  onClose,
  onSlashCommand,
  onRename,
  draggable = false,
  onDragStart: dragIndex,
}: {
  descriptor: AgentDescriptor
  index: number
  isFocused: boolean
  compact: boolean
  onFocus: () => void
  onClose: () => void
  onSlashCommand?: (cmd: string) => void
  onRename?: (id: string, name: string) => void
  draggable?: boolean
  onDragStart?: number
}) {
  const { colors, fonts, agentColors } = useTheme()
  const agent = useAgent(descriptor.id)

  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState('')
  const nameInputRef = useRef<HTMLInputElement>(null)

  const accentColor = agentColors[index % agentColors.length]

  const handleDragStart = useCallback((e: React.DragEvent) => {
    if (dragIndex == null) return
    e.dataTransfer.setData('text/plain', String(dragIndex))
    e.dataTransfer.effectAllowed = 'move'
  }, [dragIndex])

  return (
    <div
      onClick={onFocus}
      style={{
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        height: '100%',
        border: compact ? `1px solid ${isFocused ? accentColor + '60' : colors.border}` : 'none',
        background: colors.bg,
        transition: 'border-color 0.15s ease',
      }}
    >
      {/* Header — draggable for reorder */}
      <div
        draggable={draggable}
        onDragStart={handleDragStart}
        style={{
          height: 32,
          display: 'flex',
          alignItems: 'center',
          padding: '0 10px',
          gap: 6,
          background: isFocused ? `${accentColor}08` : colors.bgOverlay,
          borderBottom: `1px solid ${isFocused ? accentColor + '30' : colors.border}`,
          userSelect: 'none',
          flexShrink: 0,
          cursor: draggable ? 'grab' : 'default',
          position: 'relative',
        }}
      >
        {/* Drag grip */}
        {draggable && (
          <span style={{
            fontSize: 9,
            color: colors.textMuted,
            letterSpacing: 1,
            lineHeight: 1,
            opacity: 0.5,
          }}>
            {'\u2807'}
          </span>
        )}

        {/* Active dot */}
        <span style={{
          width: 7,
          height: 7,
          borderRadius: '50%',
          background: agent.isActive ? accentColor : colors.textMuted,
          flexShrink: 0,
          transition: 'background 0.2s',
          ...(agent.isActive ? { animation: 'pulse 1.5s infinite' } : {}),
        }} />

        {/* Name — double-click to rename */}
        {editing ? (
          <input
            ref={nameInputRef}
            value={editValue}
            onChange={e => {
              if (e.target.value.length <= 8) setEditValue(e.target.value)
            }}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                e.stopPropagation()
                const v = editValue.trim()
                if (v && onRename) onRename(descriptor.id, v)
                setEditing(false)
              }
              if (e.key === 'Escape') { e.stopPropagation(); setEditing(false) }
            }}
            onBlur={() => {
              const v = editValue.trim()
              if (v && onRename) onRename(descriptor.id, v)
              setEditing(false)
            }}
            autoFocus
            spellCheck={false}
            maxLength={8}
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: colors.text,
              background: `${colors.blue}12`,
              border: `1px solid ${colors.blue}40`,
              borderRadius: 3,
              outline: 'none',
              padding: '0 4px',
              width: 64,
              fontFamily: 'inherit',
            }}
            onClick={e => e.stopPropagation()}
          />
        ) : (
          <span
            onDoubleClick={(e) => {
              e.stopPropagation()
              setEditValue(descriptor.name)
              setEditing(true)
            }}
            title="Double-click to rename"
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: colors.text,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              cursor: 'text',
            }}
          >
            {descriptor.name}
          </span>
        )}

        {/* CWD */}
        <span
          style={{
            fontSize: 10,
            color: colors.textMuted,
            fontFamily: fonts.mono,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            flex: 1,
          }}
          title={descriptor.cwd}
        >
          {descriptor.cwd === '.'
            ? '~'
            : '~/' + descriptor.cwd.split('/').slice(-2).join('/')}
        </span>

        {/* Active indicator */}
        {agent.isActive && (
          <span style={{
            fontSize: 9,
            padding: '1px 6px',
            borderRadius: 8,
            background: `${colors.green}15`,
            color: colors.green,
            fontWeight: 500,
            whiteSpace: 'nowrap',
          }}>
            Active
          </span>
        )}

        {/* Close button */}
        <span
          onClick={(e) => { e.stopPropagation(); onClose() }}
          style={{
            fontSize: 14,
            color: colors.textMuted,
            cursor: 'pointer',
            lineHeight: 1,
            padding: '0 2px',
          }}
          title="Close agent (Cmd+W)"
        >
          ×
        </span>
      </div>

      {/* Terminal running claude CLI */}
      <div style={{ flex: 1, overflow: 'hidden', minHeight: 0 }}>
        <TerminalPanel
          agentId={descriptor.id}
          cwd={descriptor.cwd}
          mode="claude"
        />
      </div>
    </div>
  )
}
