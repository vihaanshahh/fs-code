import { useMemo, useRef } from 'react'
import type { UIMessage, AgentPhase, PhaseInfo, PermissionRequest } from '../../shared/types'
import { phaseLabelMap } from '../theme'
import { useTheme } from '../ThemeContext'

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

function inferPhase(messages: UIMessage[], isActive: boolean): { phase: AgentPhase; detail: string } {
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

  // --- Walk recent messages to build activity profile (last 30 is sufficient) ---
  const window = messages.length > 30 ? messages.slice(-30) : messages
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
    const lastFew = messages.slice(-6)
    const hadError = lastFew.some(m => m.type === 'error')
    const hadReadAfter = lastFew.some(m => m.type === 'tool-use' && (READ_TOOLS.includes(m.toolName) || SEARCH_TOOLS.includes(m.toolName)))
    if (hadError && hadReadAfter) hasErrorRecentlyThenRead = true
  }

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

  // --- Determine phase from recent activity (most specific first) ---

  // Currently streaming assistant text with no tools yet = thinking
  if (last?.type === 'assistant' && lastAssistantStreaming && recentTools.length === 0) {
    return { phase: 'thinking', detail: 'Thinking...' }
  }

  // Last tool in recent window determines fine-grained phase
  if (lastTool) {
    const { name, input } = lastTool

    // Testing: bash with test commands
    if (name === 'Bash') {
      if (TEST_COMMANDS.test(input)) return { phase: 'testing', detail: detailFromTool() }
      if (DEBUG_COMMANDS.test(input)) return { phase: 'debugging', detail: detailFromTool() }
    }

    // Agent/Skill spawn = researching
    if (AGENT_TOOLS.includes(name)) return { phase: 'researching', detail: detailFromTool() }

    // Web search/fetch = researching
    if (name === 'WebSearch' || name === 'WebFetch') return { phase: 'researching', detail: detailFromTool() }

    // Grep/Glob = searching
    if (name === 'Grep' || name === 'Glob') return { phase: 'searching', detail: detailFromTool() }
  }

  // Error then reading = debugging
  if (hasErrorRecentlyThenRead) return { phase: 'debugging', detail: detailFromTool() || 'Investigating error...' }

  // Reading after writing = reviewing
  if (readingAfterWriting) return { phase: 'reviewing', detail: detailFromTool() || 'Reviewing changes...' }

  // Has writes = coding
  if (hasWrites) return { phase: 'coding', detail: detailFromTool() || 'Writing code...' }

  // Long assistant response after reads = planning
  if (hasLongAssistantAfterReads) return { phase: 'planning', detail: 'Forming a plan...' }

  // Streaming assistant after reads = thinking
  if (last?.type === 'assistant' && lastAssistantStreaming && hasReads) {
    return { phase: 'thinking', detail: 'Analyzing...' }
  }

  // Has searches or reads = searching
  if (hasSearches || hasReads) return { phase: 'searching', detail: detailFromTool() || 'Searching...' }

  // Streaming text at start = thinking
  if (last?.type === 'assistant' && lastAssistantStreaming) {
    return { phase: 'thinking', detail: 'Thinking...' }
  }

  // Sub-agents spawned = researching
  if (hasAgentSpawns) return { phase: 'researching', detail: 'Researching...' }

  return { phase: 'thinking', detail: '' }
}

export function useJourneyPhase(
  messages: UIMessage[],
  isActive: boolean,
  permissionRequest?: PermissionRequest | null,
): PhaseInfo {
  const { phaseColorMap } = useTheme()
  const startedAtRef = useRef<Record<string, number>>({})

  return useMemo(() => {
    let { phase, detail } = inferPhase(messages, isActive)

    // Override phase to 'awaiting' when a permission request is pending
    if (permissionRequest && isActive) {
      phase = 'awaiting'
      detail = permissionRequest.toolName === 'AskUserQuestion'
        ? 'Waiting for your input'
        : `Allow ${permissionRequest.toolName}?`
    }

    if (!startedAtRef.current[phase]) {
      startedAtRef.current[phase] = Date.now()
    }

    return {
      phase,
      label: phaseLabelMap[phase] || phase,
      detail,
      color: phaseColorMap[phase] || '#888888',
      startedAt: startedAtRef.current[phase],
    }
  }, [messages, isActive, permissionRequest, phaseColorMap])
}
