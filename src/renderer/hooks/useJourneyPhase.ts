import { useMemo, useRef, useState, useEffect } from 'react'
import type { UIMessage, AgentPhase, PhaseInfo, PermissionRequest, ActiveToolInfo } from '../../shared/types'
import { phaseLabelMap } from '../theme'
import { useTheme } from '../ThemeContext'

// ── Phase progression ordering ──
// Higher = further along. Phase can only jump backward after a cooldown,
// preventing flicker when the parser briefly misdetects.
const PHASE_ORDER: Record<AgentPhase, number> = {
  idle: 0,
  thinking: 1,
  researching: 1,
  searching: 2,
  planning: 3,
  coding: 4,
  testing: 5,
  debugging: 4,
  reviewing: 4,
  done: 6,
  stuck: 0,
  awaiting: 7, // always shows immediately
}

/** Minimum ms a phase must hold before we allow moving backward */
const PHASE_HOLD_MS = 400

function formatElapsed(seconds: number): string {
  const s = Math.round(seconds)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${s % 60}s`
}

function getActiveTools(messages: UIMessage[]): ActiveToolInfo[] {
  const toolStarts = new Map<string, { toolName: string; startTs: number; elapsed: number }>()
  const completedTools = new Set<string>()

  for (const msg of messages) {
    if (msg.type === 'tool-use') {
      toolStarts.set(msg.toolUseId, { toolName: msg.toolName, startTs: msg.ts, elapsed: 0 })
    } else if (msg.type === 'tool-result') {
      completedTools.add(msg.toolUseId)
    } else if (msg.type === 'tool-progress') {
      const existing = toolStarts.get(msg.toolUseId)
      if (existing) existing.elapsed = msg.elapsed
    }
  }

  const active: ActiveToolInfo[] = []
  for (const [toolUseId, info] of toolStarts) {
    if (!completedTools.has(toolUseId)) {
      active.push({ toolUseId, toolName: info.toolName, startTs: info.startTs, elapsed: info.elapsed })
    }
  }
  return active
}

const SEARCH_TOOLS = ['Grep', 'Glob', 'WebSearch', 'WebFetch']
const READ_TOOLS = ['Read', 'Ls']
const WRITE_TOOLS = ['Edit', 'Write', 'NotebookEdit']
const AGENT_TOOLS = ['Agent', 'Skill']
const TEST_COMMANDS = /\b(test|jest|vitest|mocha|pytest|cargo test|go test|npm test|bun test|yarn test|make test|build|tsc|eslint|lint)\b/i
const DEBUG_COMMANDS = /\b(debug|gdb|lldb|strace|valgrind|console\.log|print|pdb|breakpoint)\b/i

function basename(path: string): string {
  return path.split('/').pop() || path
}

function getToolInput(msg: Extract<UIMessage, { type: 'tool-use' }>): string {
  return typeof msg.input === 'object' && msg.input !== null
    ? JSON.stringify(msg.input)
    : String(msg.input || '')
}

function inferPhase(messages: UIMessage[], isActive: boolean): { phase: AgentPhase; detail: string; activeTool?: ActiveToolInfo } {
  if (!isActive && messages.length === 0) return { phase: 'idle', detail: '' }

  const last = messages[messages.length - 1]

  // Done: result message
  if (last?.type === 'result') return { phase: 'done', detail: 'Completed' }

  // Stuck: 3+ consecutive errors
  let consecutiveErrors = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].type === 'error') consecutiveErrors++
    else break
  }
  if (consecutiveErrors >= 3) return { phase: 'stuck', detail: 'Multiple errors encountered' }

  // Session ended without result
  if (!isActive && messages.length > 0) return { phase: 'done', detail: '' }

  // --- Scope to current turn only (messages after last 'result' marker) ---
  // This prevents old tool activity from previous turns polluting the phase.
  let turnStart = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].type === 'result') {
      turnStart = i + 1
      break
    }
  }
  const turnMessages = messages.slice(turnStart)

  // If active but no messages in current turn yet, show idle (waiting for input)
  if (turnMessages.length === 0) return { phase: 'idle', detail: '' }

  const turnLast = turnMessages[turnMessages.length - 1]

  // --- Walk current turn messages to build activity profile ---
  const window = turnMessages.length > 30 ? turnMessages.slice(-30) : turnMessages
  let hasSearches = false
  let hasReads = false
  let hasWrites = false
  let hasAgentSpawns = false
  let readingAfterWriting = false
  let hasErrorRecentlyThenRead = false

  // Track recent window (last ~8 messages) for fine-grained phase
  const recentTools: { name: string; input: string }[] = []
  let lastAssistantStreaming = false
  let lastAssistantLen = 0
  let hasLongAssistantAfterReads = false
  let recentErrorCount = 0

  for (const msg of window) {
    if (msg.type === 'tool-use') {
      const name = msg.toolName
      const input = getToolInput(msg)

      recentTools.push({ name, input })
      if (recentTools.length > 8) recentTools.shift()

      if (SEARCH_TOOLS.includes(name)) hasSearches = true
      if (READ_TOOLS.includes(name)) {
        if (hasWrites) readingAfterWriting = true
        hasReads = true
      }
      if (WRITE_TOOLS.includes(name)) hasWrites = true
      if (AGENT_TOOLS.includes(name)) hasAgentSpawns = true
      if (name === 'Bash') {
        if (/\b(>|>>|tee|cp|mv|mkdir|touch|echo\s.*>)\b/.test(input)) hasWrites = true
      }

      // Reset error tracking on non-error
      recentErrorCount = 0
    }
    if (msg.type === 'error') {
      recentErrorCount++
    }
    if (msg.type === 'assistant') {
      lastAssistantStreaming = msg.isStreaming
      lastAssistantLen = msg.text.length
      if (!msg.isStreaming && hasReads && !hasWrites && msg.text.length > 200) {
        hasLongAssistantAfterReads = true
      }
    }
  }

  // Check if recently had an error then reads (= debugging)
  if (recentErrorCount > 0) {
    const lastFew = turnMessages.slice(-6)
    const hadError = lastFew.some(m => m.type === 'error')
    const hadReadAfter = lastFew.some(m => m.type === 'tool-use' && (READ_TOOLS.includes(m.toolName) || SEARCH_TOOLS.includes(m.toolName)))
    if (hadError && hadReadAfter) hasErrorRecentlyThenRead = true
  }

  // --- Active tool tracking (scoped to current turn) ---
  const activeTools = getActiveTools(turnMessages)
  const currentActiveTool = activeTools[activeTools.length - 1]
  const elapsedSuffix = currentActiveTool?.elapsed
    ? ` \u00b7 ${formatElapsed(currentActiveTool.elapsed)}`
    : ''

  // --- Detail text from last tool ---
  const lastTool = recentTools[recentTools.length - 1]
  const detailFromTool = (): string => {
    if (!lastTool) return ''
    const { name, input } = lastTool
    try {
      const parsed = JSON.parse(input)
      if (name === 'Read') {
        const fp = parsed.file_path || parsed.path || ''
        return fp ? `Reading ${basename(fp)}` : 'Reading file...'
      }
      if (name === 'Edit' || name === 'Write') {
        const fp = parsed.file_path || parsed.path || ''
        return fp ? `Editing ${basename(fp)}` : 'Writing code...'
      }
      if (name === 'Grep') return `Searching for "${(parsed.pattern || '').slice(0, 30)}"`
      if (name === 'Glob') return `Finding ${parsed.pattern || 'files'}...`
      if (name === 'Agent') return 'Spawned sub-agent...'
      if (name === 'Bash') {
        const cmd = parsed.command || ''
        if (TEST_COMMANDS.test(cmd)) return `Running ${cmd.split(' ')[0]}...`
        if (DEBUG_COMMANDS.test(cmd)) return 'Debugging...'
        return `Running command...`
      }
      if (name === 'WebSearch') return 'Searching the web...'
      if (name === 'WebFetch') return 'Fetching page...'
    } catch { /* fallthrough */ }
    return `Using ${name}...`
  }

  // Helper to build return value with active tool info
  const result = (phase: AgentPhase, detail: string) => ({
    phase,
    detail: detail + (currentActiveTool && detail ? elapsedSuffix : ''),
    activeTool: currentActiveTool,
  })

  // --- Determine phase from recent activity (most specific first) ---

  // Currently streaming assistant text with no tools yet = thinking
  if (turnLast?.type === 'assistant' && lastAssistantStreaming && recentTools.length === 0) {
    return result('thinking', 'Thinking...')
  }

  // Last tool in recent window determines fine-grained phase
  if (lastTool) {
    const { name, input } = lastTool

    // AskUserQuestion = awaiting user action
    if (name === 'AskUserQuestion') return result('awaiting', 'Needs attention')

    // Testing: bash with test commands
    if (name === 'Bash') {
      if (TEST_COMMANDS.test(input)) return result('testing', detailFromTool())
      if (DEBUG_COMMANDS.test(input)) return result('debugging', detailFromTool())
    }

    // Agent/Skill spawn = researching
    if (AGENT_TOOLS.includes(name)) return result('researching', detailFromTool())

    // Web search/fetch = researching
    if (name === 'WebSearch' || name === 'WebFetch') return result('researching', detailFromTool())

    // Grep/Glob = searching
    if (name === 'Grep' || name === 'Glob') return result('searching', detailFromTool())
  }

  // Error then reading = debugging
  if (hasErrorRecentlyThenRead) return result('debugging', detailFromTool() || 'Investigating error...')

  // Reading after writing = reviewing
  if (readingAfterWriting) return result('reviewing', detailFromTool() || 'Reviewing changes...')

  // Has writes = coding
  if (hasWrites) return result('coding', detailFromTool() || 'Writing code...')

  // Long assistant response after reads = planning
  if (hasLongAssistantAfterReads) return result('planning', 'Forming a plan...')

  // Streaming assistant after reads = thinking
  if (turnLast?.type === 'assistant' && lastAssistantStreaming && hasReads) {
    return result('thinking', 'Analyzing...')
  }

  // Has searches or reads = searching
  if (hasSearches || hasReads) return result('searching', detailFromTool() || 'Searching...')

  // Streaming text at start = thinking
  if (turnLast?.type === 'assistant' && lastAssistantStreaming) {
    return result('thinking', 'Thinking...')
  }

  // Sub-agents spawned = researching
  if (hasAgentSpawns) return result('researching', 'Researching...')

  // Nothing actively happening (no streaming, no active tools) = idle
  if (!lastAssistantStreaming && activeTools.length === 0) return { phase: 'idle', detail: '' }

  return result('thinking', '')
}

export function useJourneyPhase(
  messages: UIMessage[],
  isActive: boolean,
  permissionRequest?: PermissionRequest | null,
): PhaseInfo {
  const { phaseColorMap } = useTheme()
  const startedAtRef = useRef<Record<string, number>>({})
  const lastPhaseRef = useRef<AgentPhase>('idle')
  const lastPhaseTimeRef = useRef(0)

  // Compute raw phase
  const raw = useMemo(() => {
    let { phase, detail, activeTool } = inferPhase(messages, isActive)

    if (permissionRequest && isActive) {
      phase = 'awaiting'
      detail = permissionRequest.toolName === 'AskUserQuestion'
        ? 'Waiting for your input'
        : `Allow ${permissionRequest.toolName}?`
    }

    return { phase, detail, activeTool }
  }, [messages, isActive, permissionRequest])

  // Smooth: only allow backward jumps after PHASE_HOLD_MS
  const [smoothPhase, setSmoothPhase] = useState<AgentPhase>(raw.phase)
  const [smoothDetail, setSmoothDetail] = useState(raw.detail)
  const [smoothTool, setSmoothTool] = useState(raw.activeTool)

  useEffect(() => {
    const now = Date.now()
    const rawOrder = PHASE_ORDER[raw.phase] ?? 0
    const curOrder = PHASE_ORDER[smoothPhase] ?? 0

    // Always allow forward progression, awaiting, or done immediately.
    // idle is NOT fast-tracked — it should go through the hold period to prevent
    // brief flashes when transitioning between turns.
    if (rawOrder >= curOrder || raw.phase === 'awaiting' || raw.phase === 'done') {
      lastPhaseRef.current = raw.phase
      lastPhaseTimeRef.current = now
      setSmoothPhase(raw.phase)
      setSmoothDetail(raw.detail)
      setSmoothTool(raw.activeTool)
      return
    }

    // Backward jump — only allow after hold period
    const elapsed = now - lastPhaseTimeRef.current
    if (elapsed >= PHASE_HOLD_MS) {
      lastPhaseRef.current = raw.phase
      lastPhaseTimeRef.current = now
      setSmoothPhase(raw.phase)
      setSmoothDetail(raw.detail)
      setSmoothTool(raw.activeTool)
    } else {
      // Schedule update after remaining hold time
      const timer = setTimeout(() => {
        lastPhaseRef.current = raw.phase
        lastPhaseTimeRef.current = Date.now()
        setSmoothPhase(raw.phase)
        setSmoothDetail(raw.detail)
        setSmoothTool(raw.activeTool)
      }, PHASE_HOLD_MS - elapsed)
      return () => clearTimeout(timer)
    }
  }, [raw.phase, raw.detail, raw.activeTool]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!startedAtRef.current[smoothPhase]) {
    startedAtRef.current[smoothPhase] = Date.now()
  }

  return {
    phase: smoothPhase,
    label: phaseLabelMap[smoothPhase] || smoothPhase,
    detail: smoothDetail,
    color: phaseColorMap[smoothPhase] || '#888888',
    startedAt: startedAtRef.current[smoothPhase],
    activeTool: smoothTool,
  }
}
