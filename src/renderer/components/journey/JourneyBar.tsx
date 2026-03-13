import React, { useState, useEffect, useRef } from 'react'
import type { PhaseInfo, AgentPhase, AgentDescriptor } from '../../../shared/types'
import { useTheme } from '../../ThemeContext'
import { useAgent } from '../../hooks/useAgent'
import { useJourneyPhase } from '../../hooks/useJourneyPhase'

// Main journey steps shown in the bar
const JOURNEY_PHASES: { key: AgentPhase; label: string }[] = [
  { key: 'thinking', label: 'Thinking' },
  { key: 'searching', label: 'Searching' },
  { key: 'planning', label: 'Planning' },
  { key: 'coding', label: 'Coding' },
]

// Map sub-phases to their nearest journey step
function journeyIndex(phase: AgentPhase): number {
  switch (phase) {
    case 'idle': return -1
    case 'thinking': return 0
    case 'researching': return 0
    case 'searching': return 1
    case 'planning': return 2
    case 'coding': return 3
    case 'testing': return 3
    case 'debugging': return 3
    case 'reviewing': return 3
    case 'done': return -1
    case 'stuck': return -1
    case 'awaiting': return -1
    default: return -1
  }
}

// Invisible component that calls hooks for one agent and reports its phase upward
function AgentPhaseReporter({
  agentId,
  reportRef,
}: {
  agentId: string
  reportRef: React.MutableRefObject<(id: string, phase: PhaseInfo) => void>
}) {
  const agent = useAgent(agentId)
  const phase = useJourneyPhase(agent.messages, agent.isActive, agent.permissionRequest)
  useEffect(() => {
    reportRef.current(agentId, phase)
  }, [phase, agentId, reportRef])
  return null
}

export default function JourneyBar({
  agents,
  agentColors,
  focusedId,
  onAnyAwaiting,
}: {
  agents: AgentDescriptor[]
  agentColors: readonly string[]
  focusedId: string | null
  onAnyAwaiting?: (awaiting: boolean) => void
}) {
  const { colors, spacing } = useTheme()
  const [phases, setPhases] = useState<Record<string, PhaseInfo>>({})

  const reportRef = useRef((id: string, phase: PhaseInfo) => {
    setPhases(prev => (prev[id] === phase ? prev : { ...prev, [id]: phase }))
  })

  const focusedPhase = focusedId ? phases[focusedId] : null

  // Furthest stage any agent has reached (for connector highlighting)
  const maxStage = Math.max(-1, ...agents.map(a => {
    const ph = phases[a.id]
    return ph ? journeyIndex(ph.phase) : -1
  }))

  // Agents grouped by data for rendering
  const agentEntries = agents.map((a, i) => ({
    agent: a,
    color: agentColors[i % agentColors.length],
    phase: phases[a.id] as PhaseInfo | undefined,
  }))

  const awaitingAgents = agentEntries.filter(e => e.phase?.phase === 'awaiting')

  // Notify parent when any agent is awaiting
  useEffect(() => {
    onAnyAwaiting?.(awaitingAgents.length > 0)
  }, [awaitingAgents.length > 0]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div style={{
      height: spacing.journeyBarHeight,
      background: colors.bgOverlay,
      borderBottom: `1px solid ${colors.border}`,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 2,
      userSelect: 'none',
    }}>
      {/* Invisible phase reporters */}
      {agents.map(a => (
        <AgentPhaseReporter key={a.id} agentId={a.id} reportRef={reportRef} />
      ))}

      {/* Journey row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 0 }}>
        {JOURNEY_PHASES.map((p, stageIdx) => {
          const stageAgents = agentEntries.filter(
            e => e.phase && e.phase.phase !== 'awaiting' && journeyIndex(e.phase.phase) === stageIdx
          )
          const focusedHere = focusedPhase && focusedPhase.phase !== 'awaiting'
            && journeyIndex(focusedPhase.phase) === stageIdx
          const hasAgents = stageAgents.length > 0

          const displayLabel = focusedHere && focusedPhase!.label !== p.label
            ? focusedPhase!.label
            : p.label

          return (
            <React.Fragment key={p.key}>
              {stageIdx > 0 && (
                <div style={{
                  width: 24,
                  height: 2,
                  background: maxStage >= stageIdx ? colors.textSecondary : colors.borderMuted,
                  borderRadius: 1,
                  transition: 'background 0.3s ease',
                }} />
              )}
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: 5,
                padding: '4px 10px',
                borderRadius: 20,
                fontSize: 12,
                fontWeight: focusedHere ? 600 : 400,
                color: focusedHere
                  ? focusedPhase!.color
                  : hasAgents
                    ? colors.textSecondary
                    : colors.textMuted,
                transition: 'all 0.3s ease',
              }}>
                {/* Agent dots at this stage */}
                {stageAgents.map(({ agent, color }) => (
                  <span key={agent.id} title={`${agent.name}: ${phases[agent.id]?.label}`} style={{
                    width: 7,
                    height: 7,
                    borderRadius: '50%',
                    background: color,
                    boxShadow: focusedId === agent.id ? `0 0 6px ${color}60` : 'none',
                    transition: 'all 0.3s ease',
                    animation: agent.isActive ? 'phaseGlow 2s ease-in-out infinite' : 'none',
                    flexShrink: 0,
                  }} />
                ))}
                {/* If no agents here, show a muted dot */}
                {stageAgents.length === 0 && (
                  <span style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background: colors.textMuted,
                    transition: 'all 0.3s ease',
                    flexShrink: 0,
                  }} />
                )}
                {displayLabel}
              </div>
            </React.Fragment>
          )
        })}

        {/* Awaiting section — only shows when agents need approval */}
        {awaitingAgents.length > 0 && (
          <>
            <div style={{
              width: 16,
              height: 2,
              background: `${colors.red}60`,
              borderRadius: 1,
              marginLeft: 4,
            }} />
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: 5,
              padding: '4px 10px',
              borderRadius: 20,
              fontSize: 12,
              fontWeight: 600,
              color: colors.red,
              animation: 'pulse 1s infinite',
            }}>
              {awaitingAgents.map(({ agent, color }) => (
                <span key={agent.id} title={`${agent.name}: Awaiting approval`} style={{
                  width: 7,
                  height: 7,
                  borderRadius: '50%',
                  background: colors.red,
                  border: `1.5px solid ${color}`,
                  animation: 'pulse 1s infinite',
                  flexShrink: 0,
                }} />
              ))}
              Awaiting
            </div>
          </>
        )}
      </div>

      {/* Detail text for focused agent */}
      {focusedPhase?.detail && (
        <div style={{
          fontSize: 11,
          color: focusedPhase.color,
          opacity: 0.8,
          animation: 'fadeSlideIn 0.2s ease',
        }}>
          {focusedPhase.detail}
        </div>
      )}
    </div>
  )
}
