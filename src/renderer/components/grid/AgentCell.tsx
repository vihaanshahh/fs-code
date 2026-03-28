import React, { useCallback, useState, useEffect, useRef } from 'react'
import ConversationPanel from '../chat/ConversationPanel'
import { useAgent } from '../../hooks/useAgent'
import { useJourneyPhase } from '../../hooks/useJourneyPhase'
import { useTheme } from '../../ThemeContext'
import { api } from '../../lib/api'
import type { AgentDescriptor, PermissionMode, AskUserQuestionInput } from '../../../shared/types'
import { PERMISSION_MODE_LABELS, PROVIDER_CONFIGS } from '../../../shared/types'

const MODES: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions']

const MODE_SHORT_LABELS: Record<PermissionMode, string> = {
  default: 'Default',
  acceptEdits: 'Accept Edits',
  plan: 'Plan',
  bypassPermissions: 'YOLO',
  dontAsk: "Don't Ask",
}

const MODE_DESCRIPTIONS: Record<PermissionMode, string> = {
  default: 'Prompts for dangerous operations',
  acceptEdits: 'Auto-approve file edits, ask for the rest',
  plan: 'Think and plan without executing tools',
  bypassPermissions: 'Auto-approve everything (use with caution)',
  dontAsk: 'Deny anything not pre-approved',
}

function ModeDropdown({
  currentMode,
  onSelect,
  onClose,
}: {
  currentMode: PermissionMode
  onSelect: (mode: PermissionMode) => void
  onClose: () => void
}) {
  const { colors, fonts } = useTheme()
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  return (
    <div
      ref={ref}
      style={{
        position: 'absolute',
        top: '100%',
        left: 0,
        zIndex: 100,
        background: colors.bgSurface,
        border: `1px solid ${colors.border}`,
        borderRadius: 8,
        overflow: 'hidden',
        minWidth: 220,
        boxShadow: '0 4px 16px rgba(0,0,0,0.2)',
        animation: 'fadeSlideIn 0.1s ease',
      }}
    >
      {MODES.map(mode => (
        <div
          key={mode}
          onClick={(e) => { e.stopPropagation(); onSelect(mode) }}
          style={{
            padding: '8px 12px',
            cursor: 'pointer',
            background: mode === currentMode ? `${colors.blue}12` : 'transparent',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            transition: 'background 0.1s',
          }}
          onMouseEnter={e => { e.currentTarget.style.background = `${colors.blue}12` }}
          onMouseLeave={e => { e.currentTarget.style.background = mode === currentMode ? `${colors.blue}12` : 'transparent' }}
        >
          <span style={{
            width: 6, height: 6, borderRadius: '50%',
            background: mode === currentMode ? colors.blue : 'transparent',
            border: `1px solid ${mode === currentMode ? colors.blue : colors.borderMuted}`,
            flexShrink: 0,
          }} />
          <div>
            <div style={{ fontSize: 12, fontWeight: 500, color: colors.text }}>
              {PERMISSION_MODE_LABELS[mode]}
            </div>
            <div style={{ fontSize: 10, color: colors.textMuted }}>
              {MODE_DESCRIPTIONS[mode]}
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

/* ── Generic tool permission banner (Bash, Edit, etc.) ── */
function ToolPermissionBanner({
  toolName,
  input,
  onAllow,
  onAlwaysAllow,
  onDeny,
}: {
  toolName: string
  input: Record<string, unknown>
  onAllow: () => void
  onAlwaysAllow?: () => void
  onDeny: () => void
}) {
  const { colors, fonts } = useTheme()

  const accentMap: Record<string, string> = {
    Bash: colors.amber, Read: colors.blue, Edit: colors.amber,
    Write: colors.green, Grep: colors.purple, Glob: colors.blue,
  }
  const accent = accentMap[toolName] || colors.textSecondary

  // Extract the meaningful content to display
  const renderDetail = () => {
    if (toolName === 'Bash') {
      const cmd = input.command as string
      if (!cmd) return null
      return (
        <div style={{
          fontFamily: fonts.mono, fontSize: 11, color: colors.text,
          whiteSpace: 'pre-wrap', wordBreak: 'break-all', lineHeight: '16px',
          display: 'flex', gap: 6, alignItems: 'flex-start',
        }}>
          <span style={{ color: colors.amber, flexShrink: 0 }}>$</span>
          <span>{cmd}</span>
        </div>
      )
    }
    if (input.file_path) {
      const p = String(input.file_path)
      const parts = p.split('/')
      const name = parts.pop() || p
      const dir = parts.length > 2 ? '.../' + parts.slice(-2).join('/') + '/' : parts.join('/') + '/'
      return (
        <div style={{ fontFamily: fonts.mono, fontSize: 11, lineHeight: '16px' }}>
          <span style={{ color: colors.textMuted }}>{dir}</span>
          <span style={{ color: colors.text, fontWeight: 500 }}>{name}</span>
        </div>
      )
    }
    if (input.pattern) {
      return (
        <div style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.text, lineHeight: '16px' }}>
          {String(input.pattern)}
        </div>
      )
    }
    return null
  }

  return (
    <div
      style={{
        background: `${accent}08`,
        borderBottom: `1px solid ${accent}30`,
        padding: '8px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        flexShrink: 0,
        animation: 'fadeSlideIn 0.2s ease',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{
          fontSize: 10, fontWeight: 600, color: accent,
          textTransform: 'uppercase', letterSpacing: '0.3px',
        }}>{toolName}</span>
        <span style={{ flex: 1 }} />
        <button
          onClick={(e) => { e.stopPropagation(); onDeny() }}
          style={{
            background: 'none', border: `1px solid ${colors.borderMuted}`,
            color: colors.textSecondary, borderRadius: 6,
            padding: '3px 10px', fontSize: 11, cursor: 'pointer', flexShrink: 0,
          }}
        >Deny</button>
        <button
          onClick={(e) => { e.stopPropagation(); onAllow() }}
          style={{
            background: colors.green, border: 'none', color: '#fff',
            borderRadius: 6, padding: '3px 10px', fontSize: 11,
            fontWeight: 600, cursor: 'pointer', flexShrink: 0,
          }}
        >Allow</button>
        {onAlwaysAllow && (
          <button
            onClick={(e) => { e.stopPropagation(); onAlwaysAllow() }}
            style={{
              background: 'none', border: `1px solid ${colors.green}60`,
              color: colors.green, borderRadius: 6,
              padding: '3px 10px', fontSize: 11, fontWeight: 600,
              cursor: 'pointer', flexShrink: 0,
            }}
          >Always Allow</button>
        )}
      </div>
      {renderDetail()}
    </div>
  )
}

/* ── AskUserQuestion banner — renders questions with selectable options ── */
function AskUserQuestionBanner({
  agentId,
  requestId,
  rawInput,
  input,
  onDone,
}: {
  agentId: string
  requestId: string
  rawInput: Record<string, unknown>
  input: AskUserQuestionInput
  onDone: () => void
}) {
  const { colors, fonts } = useTheme()
  const questions = input?.questions ?? []

  // answers: { "question text": "selected option label" } (or comma-separated for multi)
  const [answers, setAnswers] = useState<Record<string, string[]>>(() => {
    const init: Record<string, string[]> = {}
    questions.forEach(q => { init[q.question] = [] })
    return init
  })

  // For "Other" custom text input per question
  const [otherText, setOtherText] = useState<Record<string, string>>({})

  const toggleOption = (question: string, label: string, multiSelect: boolean) => {
    setAnswers(prev => {
      const current = prev[question] || []
      if (multiSelect) {
        const next = current.includes(label)
          ? current.filter(l => l !== label)
          : [...current.filter(l => l !== '__other__'), label]
        return { ...prev, [question]: next }
      }
      return { ...prev, [question]: current[0] === label ? [] : [label] }
    })
  }

  const toggleOther = (question: string, multiSelect: boolean) => {
    setAnswers(prev => {
      const current = prev[question] || []
      if (current.includes('__other__')) {
        return { ...prev, [question]: current.filter(l => l !== '__other__') }
      }
      if (multiSelect) {
        return { ...prev, [question]: [...current, '__other__'] }
      }
      return { ...prev, [question]: ['__other__'] }
    })
  }

  const allAnswered = questions.every(q => {
    const sel = answers[q.question] || []
    if (sel.length === 0) return false
    if (sel.includes('__other__') && !(otherText[q.question]?.trim())) return false
    return true
  })

  const handleSubmit = () => {
    const flat: Record<string, string> = {}
    questions.forEach(q => {
      const sel = answers[q.question] || []
      const labels = sel.map(s => s === '__other__' ? (otherText[q.question]?.trim() || '') : s).filter(Boolean)
      flat[q.question] = labels.join(', ')
    })
    // Build updatedInput: spread original input + answers (matches SDK CLI format)
    const updatedInput = { ...rawInput, answers: flat }
    console.log('[AskUserQuestion] submitting:', JSON.stringify(updatedInput))
    // Call API directly with captured requestId — avoids stale closure issues
    api.respondPermission(agentId, {
      requestId,
      behavior: 'allow',
      updatedInput,
    })
    onDone()
  }

  const handleDeny = () => {
    api.respondPermission(agentId, {
      requestId,
      behavior: 'deny',
    })
    onDone()
  }

  return (
    <div
      style={{
        background: `${colors.blue}08`,
        borderBottom: `1px solid ${colors.blue}30`,
        padding: '10px 14px',
        flexShrink: 0,
        animation: 'fadeSlideIn 0.2s ease',
        maxHeight: 320,
        overflowY: 'auto',
      }}
      onClick={e => e.stopPropagation()}
    >
      {questions.map((q, qi) => (
        <div key={qi} style={{ marginBottom: qi < questions.length - 1 ? 12 : 0 }}>
          {/* Header chip */}
          {q.header && (
            <span style={{
              fontSize: 9, fontWeight: 700, textTransform: 'uppercase',
              color: colors.blue, letterSpacing: 0.5,
              background: `${colors.blue}15`, padding: '1px 6px',
              borderRadius: 3, marginBottom: 4, display: 'inline-block',
            }}>
              {q.header}
            </span>
          )}
          {/* Question text */}
          <div style={{
            fontSize: 12, fontWeight: 500, color: colors.text,
            marginBottom: 6, marginTop: q.header ? 4 : 0,
          }}>
            {q.question}
          </div>
          {/* Options */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {q.options.map((opt, oi) => {
              const selected = (answers[q.question] || []).includes(opt.label)
              return (
                <div
                  key={oi}
                  onClick={() => toggleOption(q.question, opt.label, q.multiSelect)}
                  style={{
                    display: 'flex', alignItems: 'flex-start', gap: 8,
                    padding: '6px 10px', borderRadius: 6, cursor: 'pointer',
                    border: `1px solid ${selected ? colors.blue + '60' : colors.borderMuted}`,
                    background: selected ? `${colors.blue}12` : 'transparent',
                    transition: 'all 0.1s ease',
                  }}
                >
                  {/* Radio / checkbox indicator */}
                  <span style={{
                    width: 14, height: 14, borderRadius: q.multiSelect ? 3 : '50%',
                    border: `2px solid ${selected ? colors.blue : colors.borderMuted}`,
                    background: selected ? colors.blue : 'transparent',
                    flexShrink: 0, marginTop: 1,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}>
                    {selected && (
                      <span style={{
                        width: q.multiSelect ? 8 : 6,
                        height: q.multiSelect ? 8 : 6,
                        borderRadius: q.multiSelect ? 1 : '50%',
                        background: '#fff',
                      }} />
                    )}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 500, color: colors.text }}>
                      {opt.label}
                    </div>
                    {opt.description && (
                      <div style={{ fontSize: 10, color: colors.textMuted, marginTop: 1 }}>
                        {opt.description}
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
            {/* "Other" option */}
            {(() => {
              const isOtherSelected = (answers[q.question] || []).includes('__other__')
              return (
                <div>
                  <div
                    onClick={() => toggleOther(q.question, q.multiSelect)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 8,
                      padding: '6px 10px', borderRadius: 6, cursor: 'pointer',
                      border: `1px solid ${isOtherSelected ? colors.blue + '60' : colors.borderMuted}`,
                      background: isOtherSelected ? `${colors.blue}12` : 'transparent',
                      transition: 'all 0.1s ease',
                    }}
                  >
                    <span style={{
                      width: 14, height: 14, borderRadius: q.multiSelect ? 3 : '50%',
                      border: `2px solid ${isOtherSelected ? colors.blue : colors.borderMuted}`,
                      background: isOtherSelected ? colors.blue : 'transparent',
                      flexShrink: 0,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>
                      {isOtherSelected && (
                        <span style={{
                          width: q.multiSelect ? 8 : 6,
                          height: q.multiSelect ? 8 : 6,
                          borderRadius: q.multiSelect ? 1 : '50%',
                          background: '#fff',
                        }} />
                      )}
                    </span>
                    <span style={{ fontSize: 12, fontWeight: 500, color: colors.textMuted }}>Other</span>
                  </div>
                  {isOtherSelected && (
                    <input
                      autoFocus
                      value={otherText[q.question] || ''}
                      onChange={e => setOtherText(prev => ({ ...prev, [q.question]: e.target.value }))}
                      placeholder="Type your answer..."
                      style={{
                        width: '100%', marginTop: 4, padding: '6px 10px',
                        fontSize: 12, fontFamily: fonts.mono,
                        background: colors.bgSurface, color: colors.text,
                        border: `1px solid ${colors.blue}40`, borderRadius: 6,
                        outline: 'none', boxSizing: 'border-box',
                      }}
                      onKeyDown={e => { if (e.key === 'Enter' && allAnswered) handleSubmit() }}
                    />
                  )}
                </div>
              )
            })()}
          </div>
        </div>
      ))}

      {/* Action buttons */}
      <div style={{
        display: 'flex', justifyContent: 'flex-end', gap: 8,
        marginTop: 10, paddingTop: 8,
        borderTop: `1px solid ${colors.borderMuted}`,
      }}>
        <button
          onClick={handleDeny}
          style={{
            background: 'none', border: `1px solid ${colors.borderMuted}`,
            color: colors.textSecondary, borderRadius: 6,
            padding: '4px 14px', fontSize: 11, cursor: 'pointer',
          }}
        >Skip</button>
        <button
          onClick={handleSubmit}
          disabled={!allAnswered}
          style={{
            background: allAnswered ? colors.blue : colors.borderMuted,
            border: 'none', color: '#fff', borderRadius: 6,
            padding: '4px 14px', fontSize: 11, fontWeight: 600,
            cursor: allAnswered ? 'pointer' : 'not-allowed',
            opacity: allAnswered ? 1 : 0.5,
            transition: 'all 0.15s ease',
          }}
        >Submit</button>
      </div>
    </div>
  )
}

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
  const phaseInfo = useJourneyPhase(agent.messages, agent.isActive, agent.permissionRequest)

  const [permissionMode, setPermissionMode] = useState<PermissionMode>('default')
  const [showModeDropdown, setShowModeDropdown] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState('')
  const nameInputRef = useRef<HTMLInputElement>(null)

  const accentColor = agentColors[index % agentColors.length]
  const providerConfig = PROVIDER_CONFIGS[descriptor.provider || 'claude']

  // Fetch permission mode on mount / when agent changes
  useEffect(() => {
    api.getPermissionMode(descriptor.id).then((mode: string) => {
      setPermissionMode(mode as PermissionMode)
    })
  }, [descriptor.id])

  const handleModeSelect = useCallback((mode: PermissionMode) => {
    setShowModeDropdown(false)
    api.setPermissionMode(descriptor.id, mode).then(() => {
      setPermissionMode(mode)
    })
  }, [descriptor.id])

  const handleDragStart = useCallback((e: React.DragEvent) => {
    if (dragIndex == null) return
    e.dataTransfer.setData('text/plain', String(dragIndex))
    e.dataTransfer.effectAllowed = 'move'
  }, [dragIndex])

  const modeColor = permissionMode === 'plan' ? colors.blue
    : permissionMode === 'acceptEdits' ? colors.green
    : permissionMode === 'bypassPermissions' ? colors.red
    : colors.textMuted

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
          borderBottom: `1px solid ${phaseInfo.phase === 'awaiting' ? colors.red + '60' : isFocused ? accentColor + '30' : colors.border}`,
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

        {/* Provider badge */}
        {descriptor.provider && descriptor.provider !== 'claude' && (
          <span style={{
            fontSize: 8,
            fontWeight: 700,
            padding: '1px 4px',
            borderRadius: 3,
            background: `${providerConfig.color}18`,
            color: providerConfig.color,
            letterSpacing: '0.3px',
            flexShrink: 0,
          }}>
            {providerConfig.shortLabel}
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

        {/* Permission mode pill — only for providers that support it */}
        {providerConfig.supportsPermissions && (
          <>
            <span
              onClick={(e) => { e.stopPropagation(); setShowModeDropdown(v => !v) }}
              style={{
                fontSize: 9,
                padding: '1px 6px',
                borderRadius: 4,
                background: permissionMode !== 'default' ? `${modeColor}15` : 'transparent',
                color: modeColor,
                fontWeight: 600,
                whiteSpace: 'nowrap',
                cursor: 'pointer',
                border: `1px solid ${permissionMode !== 'default' ? `${modeColor}30` : colors.borderMuted}`,
                transition: 'all 0.15s ease',
              }}
              title={`Mode: ${PERMISSION_MODE_LABELS[permissionMode]} — click to change`}
            >
              {MODE_SHORT_LABELS[permissionMode]}
            </span>

            {/* Mode dropdown */}
            {showModeDropdown && (
              <ModeDropdown
                currentMode={permissionMode}
                onSelect={handleModeSelect}
                onClose={() => setShowModeDropdown(false)}
              />
            )}
          </>
        )}

        {/* New Session + Resume — New always visible, Resume only for providers that support it */}
        <span
          onClick={(e) => { e.stopPropagation(); agent.clearMessages() }}
          style={{
            fontSize: 9,
            color: colors.textMuted,
            cursor: 'pointer',
            fontWeight: 500,
            padding: '1px 5px',
            borderRadius: 3,
            border: `1px solid ${colors.borderMuted}`,
            transition: 'all 0.15s ease',
          }}
          title="New session — clear and start fresh"
          onMouseEnter={e => { e.currentTarget.style.color = colors.text; e.currentTarget.style.borderColor = colors.border }}
          onMouseLeave={e => { e.currentTarget.style.color = colors.textMuted; e.currentTarget.style.borderColor = colors.borderMuted }}
        >
          New
        </span>
        {providerConfig.supportsResume && (
          <span
            onClick={(e) => { e.stopPropagation(); onSlashCommand?.('/resume') }}
            style={{
              fontSize: 9,
              color: colors.textMuted,
              cursor: 'pointer',
              fontWeight: 500,
              padding: '1px 5px',
              borderRadius: 3,
              border: `1px solid ${colors.borderMuted}`,
              transition: 'all 0.15s ease',
            }}
            title="Resume a previous session"
            onMouseEnter={e => { e.currentTarget.style.color = colors.text; e.currentTarget.style.borderColor = colors.border }}
            onMouseLeave={e => { e.currentTarget.style.color = colors.textMuted; e.currentTarget.style.borderColor = colors.borderMuted }}
          >
            Resume
          </span>
        )}

        {/* Mini phase pill */}
        <span style={{
          fontSize: 9,
          padding: '1px 6px',
          borderRadius: 8,
          background: `${phaseInfo.color}15`,
          color: phaseInfo.color,
          fontWeight: phaseInfo.phase === 'awaiting' ? 700 : 500,
          whiteSpace: 'nowrap',
          ...(phaseInfo.phase === 'awaiting' ? { animation: 'pulse 1s infinite' } : {}),
        }}>
          {phaseInfo.label}
        </span>

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

      {/* Sticky attention banner — permission request */}
      {agent.permissionRequest && (
        agent.permissionRequest.toolName === 'AskUserQuestion'
          ? <AskUserQuestionBanner
              agentId={descriptor.id}
              requestId={agent.permissionRequest.requestId}
              rawInput={agent.permissionRequest.input as Record<string, unknown>}
              input={agent.permissionRequest.input as AskUserQuestionInput}
              onDone={() => agent.clearPermission()}
            />
          : <ToolPermissionBanner
              toolName={agent.permissionRequest.toolName}
              input={agent.permissionRequest.input as Record<string, unknown>}
              onAllow={() => agent.respondPermission('allow')}
              onAlwaysAllow={() => agent.respondPermission('allow', undefined, true)}
              onDeny={() => agent.respondPermission('deny')}
            />
      )}

      {/* Conversation */}
      <div style={{ flex: 1, overflow: 'hidden', minHeight: 0 }}>
        <ConversationPanel
          messages={agent.messages}
          isActive={agent.isActive}
          permissionRequest={agent.permissionRequest}
          phaseInfo={phaseInfo}
          onSend={agent.sendMessage}
          onStop={agent.stopSession}
          onRespondPermission={agent.respondPermission}
          compact={compact}
          onSlashCommand={onSlashCommand}
          cwd={descriptor.cwd}
        />
      </div>
    </div>
  )
}
