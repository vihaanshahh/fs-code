import React from 'react'
import type { AgentDescriptor } from '../../../shared/types'
import { useTheme } from '../../ThemeContext'
import { useAgent } from '../../hooks/useAgent'
import { useJourneyPhase } from '../../hooks/useJourneyPhase'

/** Single agent chip inside the pill window */
function AgentChip({
  agent,
  color,
  onClick,
}: {
  agent: AgentDescriptor
  color: string
  onClick: () => void
}) {
  const { colors, fonts } = useTheme()
  const agentState = useAgent(agent.id)
  const phase = useJourneyPhase(agentState.messages, agentState.isActive, null, agentState.phaseSnapshot)
  const detailText = phase.detail || phase.label

  return (
    <div
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '3px 10px',
        borderRadius: 10,
        cursor: 'pointer',
        background: `${color}12`,
        border: `1px solid ${color}20`,
        transition: 'background 0.15s ease',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        WebkitAppRegion: 'no-drag' as any,
      }}
      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = `${color}28` }}
      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = `${color}12` }}
    >
      <span style={{
        width: 7,
        height: 7,
        borderRadius: '50%',
        background: phase.phase === 'idle' || phase.phase === 'done' ? color : phase.color,
        flexShrink: 0,
        animation: agentState.isActive ? 'pulse 1.5s infinite' : 'none',
      }} />
      <span style={{ fontSize: 11, fontWeight: 600, color: colors.text, fontFamily: fonts.mono }}>
        {agent.name}
      </span>
      {detailText && (
        <span style={{
          fontSize: 10,
          color: colors.textSecondary,
          maxWidth: 120,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}>
          {detailText}
        </span>
      )}
    </div>
  )
}

export default function MinimizedAgentsPill({
  agents,
  agentColors,
  onRestoreAgent,
}: {
  agents: AgentDescriptor[]
  agentColors: readonly string[]
  onRestoreAgent: (agentId: string) => void
}) {
  const { colors } = useTheme()

  return (
    <div style={{
      width: '100vw',
      height: '100vh',
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      padding: '0 12px',
      background: colors.bgFrosted,
      backdropFilter: 'blur(16px)',
      WebkitBackdropFilter: 'blur(16px)',
      borderRadius: 16,
      overflow: 'hidden',
      userSelect: 'none',
      // Entire window is draggable
      WebkitAppRegion: 'drag' as any,
    }}>
      {/* Agent chips */}
      {agents.map((a, i) => (
        <AgentChip
          key={a.id}
          agent={a}
          color={agentColors[i % agentColors.length]}
          onClick={() => onRestoreAgent(a.id)}
        />
      ))}

      {agents.length === 0 && (
        <span style={{ fontSize: 11, color: colors.textMuted, fontStyle: 'italic' }}>
          No agents
        </span>
      )}
    </div>
  )
}
