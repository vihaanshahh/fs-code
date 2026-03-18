import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import type { UIMessage, PermissionRequest, PhaseInfo } from '../../../shared/types'
import { useTheme } from '../../ThemeContext'
import { slashCommands } from '../palette/commands'
import { api } from '../../lib/api'
import { useSettings } from '../../hooks/useSettings'
import MarkdownRenderer from './MarkdownRenderer'

// --- Braille Spinner (CSS-only, zero re-renders) ---

const brailleStyleId = 'braille-spinner-style'
function ensureBrailleStyle() {
  if (document.getElementById(brailleStyleId)) return
  const style = document.createElement('style')
  style.id = brailleStyleId
  style.textContent = `
@keyframes braille-spin {
  0%   { content: "⠋"; }
  10%  { content: "⠙"; }
  20%  { content: "⠹"; }
  30%  { content: "⠸"; }
  40%  { content: "⠼"; }
  50%  { content: "⠴"; }
  60%  { content: "⠦"; }
  70%  { content: "⠧"; }
  80%  { content: "⠇"; }
  90%  { content: "⠏"; }
}
.braille-spinner::after {
  content: "⠋";
  animation: braille-spin 0.8s steps(1) infinite;
}`
  document.head.appendChild(style)
}

function BrailleSpinner({ color }: { color: string }) {
  useEffect(() => { ensureBrailleStyle() }, [])
  return (
    <div style={{ padding: '10px 16px', fontSize: 16, color, opacity: 0.7 }}>
      <span className="braille-spinner" />
    </div>
  )
}

// --- Message components ---

function UserMessage({ msg }: { msg: Extract<UIMessage, { type: 'user' }> }) {
  const { colors } = useTheme()
  return (
    <div style={{
      display: 'flex',
      gap: 0,
      padding: '10px 0',
      margin: '8px 0',
      animation: 'fadeSlideIn 0.2s ease',
      alignItems: 'baseline',
    }}>
      <span style={{
        color: colors.blue,
        fontWeight: 700,
        fontSize: 14,
        lineHeight: 1.5,
        userSelect: 'none',
        flexShrink: 0,
        width: 20,
      }}>
        {'>'}
      </span>
      <div style={{ fontSize: 14, color: colors.text, whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>
        {msg.text}
      </div>
    </div>
  )
}

function AssistantMessage({ msg, phaseColor }: { msg: Extract<UIMessage, { type: 'assistant' }>; phaseColor: string }) {
  return (
    <div style={{
      padding: '10px 16px',
      margin: '8px 0',
      animation: 'fadeSlideIn 0.2s ease',
    }}>
      <MarkdownRenderer text={msg.text} />
      {msg.isStreaming && (
        <span style={{ color: phaseColor, animation: 'pulse 1s infinite', marginLeft: 2 }}>|</span>
      )}
    </div>
  )
}

function ToolCard({ msg }: { msg: Extract<UIMessage, { type: 'tool-use' }> }) {
  const { colors, fonts } = useTheme()
  const input = (typeof msg.input === 'object' && msg.input ? msg.input : {}) as Record<string, unknown>
  const isEmpty = Object.keys(input).length === 0

  // Skip rendering empty-input duplicates from stream events
  if (isEmpty) return null

  const shortenPath = (p: string) => {
    const parts = p.split('/')
    if (parts.length <= 3) return p
    return '.../' + parts.slice(-3).join('/')
  }

  // ── Bash: mini terminal ──
  if (msg.toolName === 'Bash') {
    const cmd = (input.command as string) || ''
    if (!cmd) return null
    return (
      <div style={{
        margin: '4px 0',
        background: colors.bgOverlay,
        borderRadius: 6,
        border: `1px solid ${colors.border}`,
        padding: '6px 10px',
        display: 'flex',
        gap: 8,
        alignItems: 'flex-start',
      }}>
        <span style={{
          fontFamily: fonts.mono,
          fontSize: 12,
          color: colors.amber,
          userSelect: 'none',
          flexShrink: 0,
          lineHeight: '18px',
        }}>$</span>
        <code style={{
          fontFamily: fonts.mono,
          fontSize: 12,
          color: colors.text,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
          lineHeight: '18px',
        }}>{cmd}</code>
      </div>
    )
  }

  // ── Read / Edit / Write: file path ──
  if (msg.toolName === 'Read' || msg.toolName === 'Edit' || msg.toolName === 'Write') {
    const filePath = (input.file_path as string) || ''
    if (!filePath) return null
    const fileName = filePath.split('/').pop() || filePath
    const dir = shortenPath(filePath.slice(0, filePath.length - fileName.length))
    const accentColor = msg.toolName === 'Read' ? colors.blue : msg.toolName === 'Edit' ? colors.amber : colors.green
    const label = msg.toolName === 'Read' ? 'Read' : msg.toolName === 'Edit' ? 'Edit' : 'Write'
    return (
      <div style={{
        margin: '4px 0',
        padding: '5px 10px',
        display: 'flex',
        gap: 6,
        alignItems: 'center',
        fontSize: 12,
        fontFamily: fonts.mono,
      }}>
        <span style={{
          fontSize: 10,
          fontWeight: 600,
          color: accentColor,
          textTransform: 'uppercase',
          letterSpacing: '0.3px',
          flexShrink: 0,
        }}>{label}</span>
        <span style={{ color: colors.textMuted }}>{dir}</span>
        <span style={{ color: colors.text, fontWeight: 500 }}>{fileName}</span>
      </div>
    )
  }

  // ── Grep / Glob: search pattern ──
  if (msg.toolName === 'Grep' || msg.toolName === 'Glob') {
    const pattern = (input.pattern as string) || ''
    if (!pattern) return null
    const scope = (input.path as string) || (input.glob as string) || ''
    const accentColor = msg.toolName === 'Grep' ? colors.purple : colors.blue
    return (
      <div style={{
        margin: '4px 0',
        padding: '5px 10px',
        display: 'flex',
        gap: 6,
        alignItems: 'center',
        fontSize: 12,
        fontFamily: fonts.mono,
      }}>
        <span style={{
          fontSize: 10,
          fontWeight: 600,
          color: accentColor,
          textTransform: 'uppercase',
          letterSpacing: '0.3px',
          flexShrink: 0,
        }}>{msg.toolName}</span>
        <span style={{ color: colors.text }}>{pattern}</span>
        {scope && <span style={{ color: colors.textMuted }}>{shortenPath(scope)}</span>}
      </div>
    )
  }

  // ── Fallback: generic tool ──
  const summary = (input.file_path || input.command || input.pattern || input.path || '') as string
  return (
    <div style={{
      margin: '4px 0',
      padding: '5px 10px',
      display: 'flex',
      gap: 6,
      alignItems: 'center',
      fontSize: 12,
      fontFamily: fonts.mono,
    }}>
      <span style={{
        fontSize: 10,
        fontWeight: 600,
        color: colors.textSecondary,
        textTransform: 'uppercase',
        letterSpacing: '0.3px',
        flexShrink: 0,
      }}>{msg.toolName}</span>
      {summary && <span style={{ color: colors.textMuted }}>{String(summary).slice(0, 80)}</span>}
    </div>
  )
}

function ErrorMessage({ msg }: { msg: Extract<UIMessage, { type: 'error' }> }) {
  const { colors } = useTheme()
  return (
    <div style={{
      padding: '8px 12px',
      margin: '4px 0',
      fontSize: 12,
      color: colors.red,
      background: `${colors.red}08`,
      borderRadius: 8,
      border: `1px solid ${colors.red}20`,
    }}>
      {msg.message}
    </div>
  )
}

// ResultMessage intentionally not rendered — case 'result' returns null in MessageRenderer

// --- Usage Card (real API data) ---

interface UsageLimitData {
  utilization: number | null
  resets_at: string | null
}

interface ExtraUsageData {
  is_enabled: boolean
  monthly_limit: number | null
  used_credits: number | null
  utilization: number | null
}

interface UsageAPIData {
  five_hour?: UsageLimitData
  seven_day?: UsageLimitData
  seven_day_sonnet?: UsageLimitData
  extra_usage?: ExtraUsageData
}

function formatResetTime(resetsAt: string | null): string {
  if (!resetsAt) return ''
  const reset = new Date(resetsAt)
  const now = Date.now()
  const diff = reset.getTime() - now
  if (diff <= 0) return 'now'
  const hrs = Math.floor(diff / 3600000)
  const mins = Math.floor((diff % 3600000) / 60000)
  if (hrs > 24) {
    return reset.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  }
  if (hrs > 0) return `${hrs}h ${mins}m`
  return `${mins}m`
}

function UsageBar({ percent, color, bgColor }: { percent: number; color: string; bgColor: string }) {
  return (
    <div style={{
      height: 6,
      background: bgColor,
      borderRadius: 3,
      overflow: 'hidden',
    }}>
      <div style={{
        width: `${Math.min(100, Math.max(0, percent))}%`,
        height: '100%',
        background: color,
        borderRadius: 3,
        transition: 'width 0.4s ease',
      }} />
    </div>
  )
}

function UsageSectionRow({ title, limit }: { title: string; limit: UsageLimitData }) {
  const { colors, fonts } = useTheme()
  if (limit.utilization == null) return null
  const pct = Math.floor(limit.utilization)
  const barColor = pct > 80 ? colors.red : pct > 50 ? colors.amber : colors.blue
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: colors.textSecondary }}>{title}</span>
        <span style={{ fontSize: 11, fontWeight: 700, fontFamily: fonts.mono, color: barColor }}>{pct}%</span>
      </div>
      <UsageBar percent={pct} color={barColor} bgColor={`${barColor}15`} />
      {limit.resets_at && (
        <div style={{ fontSize: 10, color: colors.textMuted, marginTop: 3 }}>
          Resets {formatResetTime(limit.resets_at)}
        </div>
      )}
    </div>
  )
}

function UsageCard({ data }: { data: UsageAPIData }) {
  const { colors, fonts } = useTheme()

  const sections: { title: string; limit: UsageLimitData }[] = []
  if (data.five_hour) sections.push({ title: 'Current session', limit: data.five_hour })
  if (data.seven_day) sections.push({ title: 'Current week (all models)', limit: data.seven_day })
  if (data.seven_day_sonnet) sections.push({ title: 'Current week (Sonnet only)', limit: data.seven_day_sonnet })

  const extra = data.extra_usage

  if (sections.length === 0 && !extra) {
    return (
      <div style={{ padding: '8px 16px', fontSize: 12, color: colors.textMuted }}>
        /usage is only available for subscription plans.
      </div>
    )
  }

  return (
    <div style={{
      margin: '8px 0',
      padding: '14px 16px',
      background: colors.bgSurface,
      border: `1px solid ${colors.border}`,
      borderRadius: 10,
      animation: 'fadeSlideIn 0.2s ease',
    }}>
      {sections.map(s => (
        <UsageSectionRow key={s.title} title={s.title} limit={s.limit} />
      ))}

      {extra && extra.is_enabled && (
        <div style={{ marginBottom: 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: colors.textSecondary }}>Extra usage</span>
            {typeof extra.utilization === 'number' && (
              <span style={{ fontSize: 11, fontWeight: 700, fontFamily: fonts.mono, color: colors.blue }}>
                {Math.floor(extra.utilization)}%
              </span>
            )}
          </div>
          {typeof extra.utilization === 'number' && (
            <UsageBar percent={extra.utilization} color={colors.blue} bgColor={`${colors.blue}15`} />
          )}
          <div style={{ fontSize: 10, color: colors.textMuted, marginTop: 3 }}>
            {extra.monthly_limit == null ? 'Unlimited' : (
              `$${((extra.used_credits || 0) / 100).toFixed(2)} / $${(extra.monthly_limit / 100).toFixed(2)} spent`
            )}
          </div>
        </div>
      )}

      {extra && !extra.is_enabled && (
        <div style={{ fontSize: 11, color: colors.textMuted }}>
          Extra usage not enabled
        </div>
      )}
    </div>
  )
}

// --- Model Card ---

interface ModelData {
  current: string
  models: { value: string; displayName: string; description: string }[]
}

function ModelCard({ data, onSlashCommand }: { data: ModelData; onSlashCommand?: (cmd: string) => void }) {
  const { colors, fonts } = useTheme()

  return (
    <div style={{
      margin: '8px 0',
      padding: '14px 16px',
      background: colors.bgSurface,
      border: `1px solid ${colors.border}`,
      borderRadius: 10,
      animation: 'fadeSlideIn 0.2s ease',
    }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: colors.textSecondary, marginBottom: 10 }}>
        Model
      </div>

      {data.models.length > 0 ? data.models.map(m => {
        const isCurrent = m.value === data.current
        return (
          <div
            key={m.value}
            onClick={() => {
              if (!isCurrent && onSlashCommand) onSlashCommand(`/model ${m.value}`)
            }}
            style={{
              padding: '8px 10px',
              marginBottom: 4,
              borderRadius: 6,
              cursor: isCurrent ? 'default' : 'pointer',
              background: isCurrent ? `${colors.blue}12` : 'transparent',
              border: isCurrent ? `1px solid ${colors.blue}30` : '1px solid transparent',
              transition: 'all 0.15s ease',
            }}
            onMouseEnter={e => { if (!isCurrent) e.currentTarget.style.background = `${colors.textMuted}08` }}
            onMouseLeave={e => { if (!isCurrent) e.currentTarget.style.background = 'transparent' }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{
                fontSize: 12,
                fontFamily: fonts.mono,
                fontWeight: isCurrent ? 700 : 400,
                color: isCurrent ? colors.blue : colors.text,
              }}>
                {m.displayName}
              </span>
              {isCurrent && (
                <span style={{
                  fontSize: 9,
                  padding: '1px 6px',
                  borderRadius: 4,
                  background: `${colors.blue}20`,
                  color: colors.blue,
                  fontWeight: 600,
                }}>
                  active
                </span>
              )}
            </div>
            <div style={{ fontSize: 10, color: colors.textMuted, marginTop: 2 }}>
              {m.description}
            </div>
          </div>
        )
      }) : (
        <div style={{ fontSize: 12, fontFamily: fonts.mono, color: colors.text }}>
          {data.current || 'Unknown'}
          <span style={{ fontSize: 10, color: colors.textMuted, marginLeft: 8 }}>
            Send a message first to see available models
          </span>
        </div>
      )}
    </div>
  )
}

function SystemMessage({ msg, onSlashCommand }: { msg: Extract<UIMessage, { type: 'system' }>; onSlashCommand?: (cmd: string) => void }) {
  const { colors, fonts } = useTheme()

  if (msg.text.startsWith('__usage__')) {
    try {
      const data: UsageAPIData = JSON.parse(msg.text.slice(9))
      return <UsageCard data={data} />
    } catch { /* fall through */ }
  }

  if (msg.text.startsWith('__model__')) {
    try {
      const data: ModelData = JSON.parse(msg.text.slice(9))
      return <ModelCard data={data} onSlashCommand={onSlashCommand} />
    } catch { /* fall through */ }
  }

  return (
    <div style={{
      padding: '4px 16px',
      fontSize: 12,
      fontFamily: fonts.mono,
      color: colors.textMuted,
      whiteSpace: 'pre-wrap',
      lineHeight: 1.5,
    }}>
      {msg.text}
    </div>
  )
}

const MessageRenderer = React.memo(function MessageRenderer({ msg, phaseColor, onSlashCommand }: { msg: UIMessage; phaseColor: string; onSlashCommand?: (cmd: string) => void }) {
  switch (msg.type) {
    case 'user': return <UserMessage msg={msg} />
    case 'assistant': return <AssistantMessage msg={msg} phaseColor={phaseColor} />
    case 'tool-use': return <ToolCard msg={msg} />
    case 'error': return <ErrorMessage msg={msg} />
    case 'result': return null
    case 'system': return <SystemMessage msg={msg} onSlashCommand={onSlashCommand} />
    case 'tool-result':
    case 'tool-progress':
    case 'usage':
    case 'token-usage':
      return null
    default: return null
  }
})

// --- Permission Banner ---

function PermissionBanner({ request, onRespond }: {
  request: PermissionRequest
  onRespond: (behavior: 'allow' | 'deny', updatedInput?: Record<string, unknown>, alwaysAllow?: boolean) => void
}) {
  const { colors, fonts } = useTheme()
  const input = request.input || {}

  const accentMap: Record<string, string> = {
    Bash: colors.amber, Read: colors.blue, Edit: colors.amber,
    Write: colors.green, Grep: colors.purple, Glob: colors.blue,
  }
  const accent = accentMap[request.toolName] || colors.textSecondary

  const shortenPath = (p: string) => {
    const parts = p.split('/')
    if (parts.length <= 3) return p
    return '.../' + parts.slice(-3).join('/')
  }

  const renderDetail = () => {
    if (request.toolName === 'Bash') {
      const cmd = input.command as string
      if (!cmd) return null
      return (
        <div style={{
          margin: '8px 0 0',
          background: colors.bgOverlay,
          borderRadius: 6,
          border: `1px solid ${colors.border}`,
          padding: '6px 10px',
          display: 'flex', gap: 8, alignItems: 'flex-start',
        }}>
          <span style={{ fontFamily: fonts.mono, fontSize: 12, color: colors.amber, flexShrink: 0, lineHeight: '18px' }}>$</span>
          <code style={{ fontFamily: fonts.mono, fontSize: 12, color: colors.text, whiteSpace: 'pre-wrap', wordBreak: 'break-all', lineHeight: '18px' }}>{cmd}</code>
        </div>
      )
    }
    if (request.toolName === 'Read' || request.toolName === 'Edit' || request.toolName === 'Write') {
      const filePath = input.file_path as string
      if (!filePath) return null
      const fileName = filePath.split('/').pop() || filePath
      const dir = shortenPath(filePath.slice(0, filePath.length - fileName.length))
      return (
        <div style={{ margin: '6px 0 0', fontFamily: fonts.mono, fontSize: 12, display: 'flex', gap: 4, alignItems: 'center' }}>
          <span style={{ color: colors.textMuted }}>{dir}</span>
          <span style={{ color: colors.text, fontWeight: 500 }}>{fileName}</span>
        </div>
      )
    }
    if (request.toolName === 'Grep' || request.toolName === 'Glob') {
      const pattern = input.pattern as string
      if (!pattern) return null
      const scope = (input.path || input.glob || '') as string
      return (
        <div style={{ margin: '6px 0 0', fontFamily: fonts.mono, fontSize: 12, display: 'flex', gap: 6, alignItems: 'center' }}>
          <span style={{ color: colors.text }}>{pattern}</span>
          {scope && <span style={{ color: colors.textMuted }}>{shortenPath(scope)}</span>}
        </div>
      )
    }
    // Fallback for unknown tools
    const summary = (input.file_path || input.command || input.pattern || input.path || '') as string
    if (summary) {
      return (
        <div style={{ margin: '6px 0 0', fontFamily: fonts.mono, fontSize: 12, color: colors.textMuted }}>
          {String(summary).slice(0, 100)}
        </div>
      )
    }
    return null
  }

  return (
    <div style={{
      margin: '8px 0',
      padding: '10px 14px',
      background: `${accent}08`,
      border: `1px solid ${accent}30`,
      borderRadius: 10,
      animation: 'fadeSlideIn 0.2s ease',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{
          fontSize: 10, fontWeight: 600, color: accent,
          textTransform: 'uppercase', letterSpacing: '0.3px',
        }}>{request.toolName}</span>
        <span style={{ flex: 1 }} />
        <button
          onClick={() => onRespond('deny')}
          style={{
            background: 'none', border: `1px solid ${colors.borderMuted}`,
            color: colors.textSecondary, borderRadius: 6,
            padding: '4px 12px', fontSize: 11, cursor: 'pointer',
          }}
        >Deny</button>
        <button
          onClick={() => onRespond('allow')}
          style={{
            background: colors.green, border: 'none', color: '#fff',
            borderRadius: 6, padding: '4px 12px', fontSize: 11,
            fontWeight: 600, cursor: 'pointer',
          }}
        >Allow</button>
        {request.suggestions && request.suggestions.length > 0 && (
          <button
            onClick={() => onRespond('allow', undefined, true)}
            style={{
              background: 'none', border: `1px solid ${colors.green}60`,
              color: colors.green, borderRadius: 6,
              padding: '4px 12px', fontSize: 11, fontWeight: 600,
              cursor: 'pointer',
            }}
          >Always Allow</button>
        )}
      </div>
      {renderDetail()}
    </div>
  )
}

// --- Slash Command Autocomplete ---

function SlashAutocomplete({ filter, selectedIndex, onSelect, compact }: {
  filter: string
  selectedIndex: number
  onSelect: (cmd: string) => void
  compact: boolean
}) {
  const { colors, fonts } = useTheme()
  const listRef = useRef<HTMLDivElement>(null)

  const matches = useMemo(() => {
    const q = filter.toLowerCase()
    return slashCommands.filter(c =>
      c.command.includes(q) ||
      c.description.toLowerCase().includes(q) ||
      c.aliases?.some(a => a.includes(q))
    ).slice(0, compact ? 6 : 10)
  }, [filter, compact])

  // Scroll selected item into view
  useEffect(() => {
    const el = listRef.current?.children[selectedIndex] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  if (matches.length === 0) return null

  const categoryColors: Record<string, string> = {
    session: colors.blue,
    history: colors.purple,
    agent: colors.green,
    view: colors.amber,
    config: colors.textSecondary,
    info: colors.blue,
    misc: colors.textMuted,
  }

  return (
    <div style={{
      position: 'absolute',
      bottom: '100%',
      left: compact ? 8 : 24,
      right: compact ? 8 : 24,
      maxHeight: compact ? 200 : 320,
      overflowY: 'auto',
      background: colors.bgSurface,
      border: `1px solid ${colors.border}`,
      borderRadius: 10,
      marginBottom: 4,
      boxShadow: '0 -4px 20px rgba(0,0,0,0.15)',
      zIndex: 20,
    }} ref={listRef}>
      {matches.map((cmd, i) => (
        <div
          key={cmd.command}
          onMouseDown={e => { e.preventDefault(); onSelect(cmd.command) }}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '7px 12px',
            cursor: 'pointer',
            background: i === selectedIndex ? `${colors.blue}12` : 'transparent',
            borderLeft: i === selectedIndex ? `2px solid ${colors.blue}` : '2px solid transparent',
            transition: 'background 0.08s ease',
          }}
          onMouseEnter={e => {
            if (i !== selectedIndex) e.currentTarget.style.background = `${colors.textMuted}08`
          }}
          onMouseLeave={e => {
            if (i !== selectedIndex) e.currentTarget.style.background = 'transparent'
          }}
        >
          <span style={{
            fontFamily: fonts.mono,
            fontSize: 12,
            fontWeight: 600,
            color: categoryColors[cmd.category] || colors.text,
            minWidth: compact ? 80 : 110,
            flexShrink: 0,
          }}>
            {cmd.command}
          </span>
          <span style={{
            fontSize: 11,
            color: colors.textMuted,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            flex: 1,
          }}>
            {cmd.description}
          </span>
          <span style={{
            fontSize: 9,
            color: colors.textMuted,
            opacity: 0.5,
            textTransform: 'uppercase',
            letterSpacing: '0.5px',
            flexShrink: 0,
          }}>
            {cmd.category}
          </span>
        </div>
      ))}
    </div>
  )
}

// --- File @ Mention Autocomplete ---

function FileAutocomplete({ files, selectedIndex, onSelect, compact }: {
  files: string[]
  selectedIndex: number
  onSelect: (filePath: string) => void
  compact: boolean
}) {
  const { colors, fonts } = useTheme()
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = listRef.current?.children[selectedIndex] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  if (files.length === 0) return null

  // File extension -> color mapping
  const extColor = (path: string): string => {
    const ext = path.split('.').pop()?.toLowerCase() || ''
    const map: Record<string, string> = {
      ts: colors.blue, tsx: colors.blue, js: colors.amber, jsx: colors.amber,
      py: colors.green, rs: colors.red, go: colors.blue, css: colors.purple,
      html: colors.red, json: colors.amber, md: colors.textSecondary,
      yaml: colors.green, yml: colors.green, toml: colors.amber,
    }
    return map[ext] || colors.textMuted
  }

  return (
    <div style={{
      position: 'absolute',
      bottom: '100%',
      left: compact ? 8 : 24,
      right: compact ? 8 : 24,
      maxHeight: compact ? 200 : 320,
      overflowY: 'auto',
      background: colors.bgSurface,
      border: `1px solid ${colors.border}`,
      borderRadius: 10,
      marginBottom: 4,
      boxShadow: '0 -4px 20px rgba(0,0,0,0.15)',
      zIndex: 20,
    }} ref={listRef}>
      <div style={{
        padding: '6px 12px 4px',
        fontSize: 10,
        fontWeight: 600,
        color: colors.textMuted,
        textTransform: 'uppercase',
        letterSpacing: '0.5px',
      }}>
        Files
      </div>
      {files.map((filePath, i) => {
        const parts = filePath.split('/')
        const fileName = parts.pop() || filePath
        const dir = parts.length > 0 ? parts.join('/') + '/' : ''
        return (
          <div
            key={filePath}
            onMouseDown={e => { e.preventDefault(); onSelect(filePath) }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '6px 12px',
              cursor: 'pointer',
              background: i === selectedIndex ? `${colors.blue}12` : 'transparent',
              borderLeft: i === selectedIndex ? `2px solid ${colors.blue}` : '2px solid transparent',
              transition: 'background 0.08s ease',
            }}
            onMouseEnter={e => {
              if (i !== selectedIndex) e.currentTarget.style.background = `${colors.textMuted}08`
            }}
            onMouseLeave={e => {
              if (i !== selectedIndex) e.currentTarget.style.background = 'transparent'
            }}
          >
            <span style={{
              fontSize: 9,
              color: extColor(filePath),
              flexShrink: 0,
              fontFamily: fonts.mono,
              fontWeight: 700,
              background: `${extColor(filePath)}15`,
              padding: '1px 4px',
              borderRadius: 3,
              lineHeight: '14px',
              minWidth: 28,
              textAlign: 'center',
            }}>
              {fileName.includes('.') ? fileName.split('.').pop() : '—'}
            </span>
            <span style={{
              fontFamily: fonts.mono,
              fontSize: 12,
              fontWeight: 600,
              color: colors.text,
              flexShrink: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}>
              {fileName}
            </span>
            {dir && (
              <span style={{
                fontSize: 11,
                color: colors.textMuted,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                flex: 1,
                direction: 'rtl',
                textAlign: 'left',
              }}>
                {dir}
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}

// --- Main Component ---

export default function ConversationPanel({
  messages,
  isActive,
  permissionRequest,
  phaseInfo,
  onSend,
  onStop,
  onRespondPermission,
  compact = false,
  onSlashCommand,
  cwd,
}: {
  messages: UIMessage[]
  isActive: boolean
  permissionRequest: PermissionRequest | null
  phaseInfo: PhaseInfo
  onSend: (text: string) => void
  onStop: () => void
  onRespondPermission: (behavior: 'allow' | 'deny', updatedInput?: Record<string, unknown>, alwaysAllow?: boolean) => void
  compact?: boolean
  onSlashCommand?: (cmd: string) => void
  cwd?: string
}) {
  const { colors, spacing } = useTheme()
  const [settings] = useSettings()
  const [input, setInput] = useState('')
  const [slashIndex, setSlashIndex] = useState(0)
  const [contextFiles, setContextFiles] = useState<string[]>([])
  const endRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // --- @ mention state ---
  const [atMentionActive, setAtMentionActive] = useState(false)
  const [atMentionQuery, setAtMentionQuery] = useState('')
  const [atMentionStart, setAtMentionStart] = useState(-1) // cursor position of the @
  const [atMentionIndex, setAtMentionIndex] = useState(0)
  const [atMentionFiles, setAtMentionFiles] = useState<string[]>([])

  // Determine if we should show autocomplete
  const showAutocomplete = input.startsWith('/') && !input.includes(' ') && !atMentionActive
  const slashFilter = showAutocomplete ? input : ''

  // Get filtered matches for keyboard nav
  const filteredMatches = useMemo(() => {
    if (!showAutocomplete) return []
    const q = slashFilter.toLowerCase()
    return slashCommands.filter(c =>
      c.command.includes(q) ||
      c.description.toLowerCase().includes(q) ||
      c.aliases?.some(a => a.includes(q))
    ).slice(0, compact ? 6 : 10)
  }, [slashFilter, showAutocomplete, compact])

  // Reset selection when filter changes
  useEffect(() => { setSlashIndex(0) }, [slashFilter])

  // Search files when @ mention query changes
  useEffect(() => {
    if (!atMentionActive || !cwd) {
      setAtMentionFiles([])
      return
    }
    let cancelled = false
    const doSearch = async () => {
      try {
        const results = await api.searchFiles(cwd, atMentionQuery, compact ? 6 : 10)
        if (!cancelled) {
          setAtMentionFiles(results)
          setAtMentionIndex(0)
        }
      } catch {
        if (!cancelled) setAtMentionFiles([])
      }
    }
    // Small debounce for typing
    const timer = setTimeout(doSearch, atMentionQuery ? 80 : 0)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [atMentionActive, atMentionQuery, cwd, compact])

  // Detect @ mentions in input (only when enabled in settings)
  const updateAtMention = useCallback((value: string, cursorPos: number) => {
    if (!settings.atMentionsEnabled) {
      setAtMentionActive(false)
      return
    }
    // Look backwards from cursor for an unmatched @
    let atPos = -1
    for (let i = cursorPos - 1; i >= 0; i--) {
      const ch = value[i]
      if (ch === '@') {
        // Check it's at start of input or preceded by a space/newline
        if (i === 0 || value[i - 1] === ' ' || value[i - 1] === '\n') {
          atPos = i
        }
        break
      }
      if (ch === ' ' || ch === '\n') break
    }

    if (atPos >= 0) {
      const query = value.substring(atPos + 1, cursorPos)
      setAtMentionActive(true)
      setAtMentionQuery(query)
      setAtMentionStart(atPos)
    } else {
      setAtMentionActive(false)
      setAtMentionQuery('')
      setAtMentionStart(-1)
    }
  }, [settings.atMentionsEnabled])

  // Auto-scroll
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length, messages[messages.length - 1]])

  // Auto-focus
  useEffect(() => { inputRef.current?.focus() }, [])

  // Reset textarea height when input is cleared
  useEffect(() => {
    if (inputRef.current) {
      if (!input) {
        inputRef.current.style.height = '21px';
      } else {
        inputRef.current.style.height = 'auto';
        inputRef.current.style.height = Math.min(inputRef.current.scrollHeight, 84) + 'px';
      }
    }
  }, [input])

  const selectSlashCommand = (cmd: string) => {
    // If command takes args (like /btw, /model, /rename), insert with trailing space
    const needsArg = ['/btw', '/model', '/rename', '/resume', '/compact', '/permissions', '/pr-comments', '/add-dir'].includes(cmd)
    if (needsArg) {
      setInput(cmd + ' ')
    } else {
      // Execute immediately
      if (onSlashCommand) onSlashCommand(cmd)
      setInput('')
    }
    inputRef.current?.focus()
  }

  const selectFileMention = useCallback((filePath: string) => {
    // Add file to context files list
    if (!contextFiles.includes(filePath)) {
      setContextFiles(prev => [...prev, filePath])
    }
    // Replace the @query with nothing (the file shows as a pill above)
    const before = input.substring(0, atMentionStart)
    const after = input.substring(atMentionStart + 1 + atMentionQuery.length)
    setInput(before + after)
    setAtMentionActive(false)
    setAtMentionQuery('')
    setAtMentionStart(-1)
    inputRef.current?.focus()
  }, [input, atMentionStart, atMentionQuery, contextFiles])

  const removeContextFile = useCallback((filePath: string) => {
    setContextFiles(prev => prev.filter(f => f !== filePath))
  }, [])

  const handleSubmit = () => {
    const text = input.trim()
    if (!text && contextFiles.length === 0) return

    // If @ autocomplete is open, select highlighted file
    if (atMentionActive && atMentionFiles.length > 0) {
      selectFileMention(atMentionFiles[atMentionIndex])
      return
    }

    // If autocomplete is open and user presses Enter, select the highlighted command
    if (showAutocomplete && filteredMatches.length > 0) {
      selectSlashCommand(filteredMatches[slashIndex].command)
      return
    }

    // Check for slash commands
    if (text.startsWith('/') && onSlashCommand) {
      onSlashCommand(text)
      setInput('')
      return
    }

    // Build message with context file references
    let message = text
    if (contextFiles.length > 0) {
      const fileRefs = contextFiles.map(f => `@${f}`).join(' ')
      message = `${fileRefs} ${text}`.trim()
    }
    onSend(message)
    setInput('')
    setContextFiles([])
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // @ mention autocomplete navigation
    if (atMentionActive && atMentionFiles.length > 0) {
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setAtMentionIndex(prev => (prev > 0 ? prev - 1 : atMentionFiles.length - 1))
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setAtMentionIndex(prev => (prev < atMentionFiles.length - 1 ? prev + 1 : 0))
        return
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault()
        selectFileMention(atMentionFiles[atMentionIndex])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setAtMentionActive(false)
        return
      }
    }

    // Slash autocomplete navigation
    if (showAutocomplete && filteredMatches.length > 0) {
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSlashIndex(prev => (prev > 0 ? prev - 1 : filteredMatches.length - 1))
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSlashIndex(prev => (prev < filteredMatches.length - 1 ? prev + 1 : 0))
        return
      }
      if (e.key === 'Tab') {
        e.preventDefault()
        selectSlashCommand(filteredMatches[slashIndex].command)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setInput('')
        return
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    }
  }

  return (
    <div style={{
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
    }}>
      {/* Messages area */}
      <div style={{
        flex: 1,
        overflow: 'auto',
        display: 'flex',
        justifyContent: 'center',
      }}>
        <div style={{
          width: '100%',
          maxWidth: compact ? undefined : spacing.conversationMaxWidth,
          padding: compact ? '8px 12px 60px' : '16px 24px 80px',
        }}>
          {messages.length === 0 && (
            <div style={{
              textAlign: 'center',
              padding: compact ? '40px 12px' : '80px 20px',
              color: colors.textMuted,
              fontSize: compact ? 12 : 14,
            }}>
              <div style={{ fontSize: compact ? 14 : 18, fontWeight: 300, marginBottom: compact ? 6 : 12, color: colors.textSecondary }}>Fluid State AI</div>
              <div>What would you like to build?</div>
            </div>
          )}
          {messages.map(msg => (
            <MessageRenderer key={msg.id} msg={msg} phaseColor={phaseInfo.color} onSlashCommand={onSlashCommand} />
          ))}
          {isActive && (() => {
            const last = messages[messages.length - 1]
            const showSpinner = !last || last.type !== 'assistant' || !last.isStreaming
            return showSpinner ? <BrailleSpinner color={phaseInfo.color} /> : null
          })()}
          <div ref={endRef} />
        </div>
      </div>

      {/* Sticky bottom: permission + input + autocomplete */}
      <div style={{
        position: 'relative',
        padding: compact ? '0 8px 8px' : '0 24px 12px',
        display: 'flex',
        justifyContent: 'center',
      }}>
        <div style={{ width: '100%', maxWidth: compact ? undefined : spacing.conversationMaxWidth, position: 'relative' }}>
          {/* Slash command autocomplete */}
          {showAutocomplete && filteredMatches.length > 0 && (
            <SlashAutocomplete
              filter={slashFilter}
              selectedIndex={slashIndex}
              onSelect={selectSlashCommand}
              compact={compact}
            />
          )}

          {/* @ file mention autocomplete */}
          {atMentionActive && atMentionFiles.length > 0 && (
            <FileAutocomplete
              files={atMentionFiles}
              selectedIndex={atMentionIndex}
              onSelect={selectFileMention}
              compact={compact}
            />
          )}

          {/* Permission banner — skip AskUserQuestion (handled by AgentCell sticky banner) */}
          {permissionRequest && permissionRequest.toolName !== 'AskUserQuestion' && (
            <PermissionBanner request={permissionRequest} onRespond={onRespondPermission} />
          )}

          {/* Context file pills */}
          {contextFiles.length > 0 && (
            <div style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 4,
              padding: '6px 0 2px',
              borderTop: `1px solid ${colors.border}`,
            }}>
              {contextFiles.map(filePath => {
                const fileName = filePath.split('/').pop() || filePath
                return (
                  <span
                    key={filePath}
                    title={filePath}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 4,
                      padding: '2px 8px',
                      background: `${colors.blue}15`,
                      border: `1px solid ${colors.blue}30`,
                      borderRadius: 6,
                      fontSize: 11,
                      fontFamily: 'inherit',
                      color: colors.blue,
                      fontWeight: 500,
                      cursor: 'default',
                      maxWidth: 200,
                    }}
                  >
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      @{fileName}
                    </span>
                    <span
                      onClick={() => removeContextFile(filePath)}
                      style={{
                        cursor: 'pointer',
                        fontSize: 13,
                        lineHeight: 1,
                        opacity: 0.6,
                        fontWeight: 400,
                      }}
                      onMouseEnter={e => { (e.target as HTMLElement).style.opacity = '1' }}
                      onMouseLeave={e => { (e.target as HTMLElement).style.opacity = '0.6' }}
                    >
                      ×
                    </span>
                  </span>
                )
              })}
            </div>
          )}

          {/* Input area */}
          <div style={{
            display: 'flex',
            gap: 0,
            alignItems: 'flex-start',
            borderTop: contextFiles.length > 0 ? 'none' : `1px solid ${colors.border}`,
            padding: compact ? '6px 0 0' : '8px 0 0',
          }}>
            {/* Blue prompt chevron — matches UserMessage > */}
            <span style={{
              color: colors.blue,
              fontSize: 14,
              fontWeight: 700,
              height: 21,
              lineHeight: '21px',
              userSelect: 'none',
              flexShrink: 0,
              width: compact ? 16 : 20,
            }}>
              {'>'}
            </span>
            <textarea
              ref={inputRef}
              value={input}
              onChange={e => {
                const value = e.target.value;
                setInput(value);
                const ta = e.target;
                ta.style.height = 'auto';
                ta.style.height = Math.min(ta.scrollHeight, 84) + 'px';
                // Detect @ mentions
                updateAtMention(value, ta.selectionStart);
              }}
              placeholder={compact ? 'Message...' : `Message ${settings.defaultProvider === 'claude' ? 'Claude' : settings.defaultProvider === 'copilot' ? 'Copilot' : settings.defaultProvider === 'openai' ? 'Codex' : 'Gemini'}...`}
              onKeyDown={handleKeyDown}
              style={{
                flex: 1,
                background: 'transparent',
                border: 'none',
                color: colors.text,
                padding: 0,
                fontSize: 14,
                fontFamily: 'inherit',
                resize: 'none',
                outline: 'none',
                minHeight: 21,
                maxHeight: 84,
                lineHeight: '21px',
                overflowY: 'auto',
              }}
              rows={1}
            />
            {isActive && (
              <button
                onClick={onStop}
                style={{
                  background: 'none',
                  border: 'none',
                  color: colors.red,
                  fontSize: compact ? 11 : 12,
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                  fontWeight: 500,
                  padding: compact ? '3px 4px' : '5px 4px',
                  opacity: 0.8,
                }}
              >
                Stop
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
