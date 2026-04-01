import React, { useState, useEffect, useRef } from 'react'
import type { PhaseInfo, AgentPhase, AgentDescriptor } from '../../../shared/types'
import { useTheme } from '../../ThemeContext'
import { useAgent } from '../../hooks/useAgent'
import { useJourneyPhase } from '../../hooks/useJourneyPhase'
import { useCodexStatus } from '../../hooks/useCodexStatus'
import { useGhCliStatus } from '../../hooks/useGhCliStatus'

const JOURNEY_PHASES: { key: AgentPhase; label: string }[] = [
  { key: 'thinking', label: 'Thinking' },
  { key: 'searching', label: 'Searching' },
  { key: 'planning', label: 'Planning' },
  { key: 'coding', label: 'Coding' },
  { key: 'testing', label: 'Testing' },
]

function journeyIndex(phase: AgentPhase): number {
  switch (phase) {
    case 'idle': return -1
    case 'thinking': return 0
    case 'researching': return 0
    case 'searching': return 1
    case 'planning': return 2
    case 'coding': return 3
    case 'debugging': return 3
    case 'reviewing': return 3
    case 'testing': return 4
    case 'done': return -1
    case 'stuck': return -1
    case 'awaiting': return -1
    default: return -1
  }
}

function StatusPill({
  dotColor,
  animate,
  label,
  textColor,
}: {
  dotColor: string
  animate?: boolean
  label: string
  textColor: string
}) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 4,
      padding: '1px 6px',
      borderRadius: 20,
      fontSize: 9,
      fontWeight: 500,
      color: textColor,
      opacity: 0.8,
    }}>
      <span style={{
        width: 4,
        height: 4,
        borderRadius: '50%',
        flexShrink: 0,
        background: dotColor,
        animation: animate ? 'phaseGlow 1.5s ease-in-out infinite' : 'none',
      }} />
      {label}
    </div>
  )
}

function AgentPhaseReporter({
  agentId,
  reportRef,
}: {
  agentId: string
  reportRef: React.MutableRefObject<(id: string, phase: PhaseInfo) => void>
}) {
  const agent = useAgent(agentId)
  const phase = useJourneyPhase(agent.messages, agent.isActive, null, agent.phaseSnapshot)
  useEffect(() => {
    reportRef.current(agentId, phase)
  }, [phase, agentId, reportRef])
  return null
}

function SystemStatusStrip({ focusedId }: { focusedId: string | null }) {
  const { colors } = useTheme()
  const codexStatus = useCodexStatus(focusedId)
  const ghStatus = useGhCliStatus()

  const codexLabel = codexStatus
    ? codexStatus.state === 'ready' ? 'Codex'
    : codexStatus.state === 'loading' ? 'Codex loading'
    : codexStatus.state === 'indexing'
      ? (codexStatus.totalFiles ? `Indexing ${codexStatus.filesProcessed}/${codexStatus.totalFiles}` : 'Indexing')
    : 'Codex error'
    : null

  const codexDotColor = !codexStatus ? colors.textMuted
    : codexStatus.state === 'ready' ? colors.green
    : codexStatus.state === 'error' ? colors.red
    : colors.textMuted

  const ghLabel = !ghStatus ? null
    : ghStatus.state === 'authenticated' ? (ghStatus.user ? `gh @${ghStatus.user}` : 'gh')
    : ghStatus.state === 'not_authenticated' ? 'gh not auth'
    : 'gh not found'

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      {codexStatus && codexLabel && (
        <StatusPill
          dotColor={codexDotColor}
          animate={codexStatus.state === 'loading' || codexStatus.state === 'indexing'}
          label={codexLabel}
          textColor={codexDotColor}
        />
      )}
      {ghStatus && ghLabel && (
        <StatusPill
          dotColor={ghStatus.state === 'authenticated' ? colors.green : colors.textMuted}
          label={ghLabel}
          textColor={ghStatus.state === 'authenticated' ? colors.green : colors.textMuted}
        />
      )}
    </div>
  )
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
  const { colors } = useTheme()
  const [phases, setPhases] = useState<Record<string, PhaseInfo>>({})

  const reportRef = useRef((id: string, phase: PhaseInfo) => {
    setPhases(prev => {
      const old = prev[id]
      if (old && old.phase === phase.phase && old.detail === phase.detail && old.label === phase.label) return prev
      return { ...prev, [id]: phase }
    })
  })

  const focusedPhase = focusedId ? phases[focusedId] : null

  const maxStage = Math.max(-1, ...agents.map(a => {
    const ph = phases[a.id]
    return ph ? journeyIndex(ph.phase) : -1
  }))

  const agentEntries = agents.map((a, i) => ({
    agent: a,
    color: agentColors[i % agentColors.length],
    phase: phases[a.id] as PhaseInfo | undefined,
  }))

  const needsAttentionAgents = agentEntries.filter(
    e => e.phase?.phase === 'awaiting' || e.phase?.phase === 'stuck'
  )
  const doneAgents = agentEntries.filter(e => e.phase?.phase === 'done')

  useEffect(() => {
    onAnyAwaiting?.(needsAttentionAgents.length > 0)
  }, [needsAttentionAgents.length > 0]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 4,
      userSelect: 'none',
      pointerEvents: 'none',
    }}>
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
                  width: 14,
                  height: 1.5,
                  background: maxStage >= stageIdx ? colors.textSecondary : colors.borderMuted,
                  borderRadius: 1,
                  transition: 'background 0.3s ease',
                }} />
              )}
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                padding: '2px 6px',
                borderRadius: 20,
                fontSize: 10,
                fontWeight: focusedHere ? 600 : 400,
                color: focusedHere
                  ? focusedPhase!.color
                  : hasAgents
                    ? colors.textSecondary
                    : colors.textMuted,
                transition: 'all 0.3s ease',
              }}>
                {stageAgents.map(({ agent, color }) => (
                  <span key={agent.id} title={`${agent.name}: ${phases[agent.id]?.label}`} style={{
                    width: 5,
                    height: 5,
                    borderRadius: '50%',
                    background: color,
                    boxShadow: focusedId === agent.id ? `0 0 6px ${color}60` : 'none',
                    transition: 'all 0.3s ease',
                    animation: agent.isActive ? 'phaseGlow 2s ease-in-out infinite' : 'none',
                    flexShrink: 0,
                  }} />
                ))}
                {stageAgents.length === 0 && (
                  <span style={{
                    width: 5,
                    height: 5,
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

        {doneAgents.length > 0 && (
          <>
            <div style={{
              width: 10,
              height: 1.5,
              background: `${colors.green}50`,
              borderRadius: 1,
              marginLeft: 2,
            }} />
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              padding: '2px 6px',
              borderRadius: 20,
              fontSize: 10,
              fontWeight: 500,
              color: colors.green,
              opacity: 0.8,
            }}>
              {doneAgents.map(({ agent, color }) => (
                <span key={agent.id} title={`${agent.name}: Done`} style={{
                  width: 5,
                  height: 5,
                  borderRadius: '50%',
                  background: colors.green,
                  border: `1.5px solid ${color}`,
                  flexShrink: 0,
                }} />
              ))}
              Done
            </div>
          </>
        )}

        {needsAttentionAgents.length > 0 && (
          <>
            <div style={{
              width: 10,
              height: 1.5,
              background: `${colors.red}60`,
              borderRadius: 1,
              marginLeft: 2,
            }} />
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              padding: '2px 6px',
              borderRadius: 20,
              fontSize: 10,
              fontWeight: 600,
              color: colors.red,
              animation: 'pulse 1s infinite',
            }}>
              {needsAttentionAgents.map(({ agent, color, phase }) => (
                <span key={agent.id} title={`${agent.name}: ${phase?.label || 'Needs attention'}`} style={{
                  width: 5,
                  height: 5,
                  borderRadius: '50%',
                  background: colors.red,
                  border: `1.5px solid ${color}`,
                  animation: 'pulse 1s infinite',
                  flexShrink: 0,
                }} />
              ))}
              Needs Attention
            </div>
          </>
        )}
      </div>

      <SystemStatusStrip focusedId={focusedId} />
    </div>
  )
}
