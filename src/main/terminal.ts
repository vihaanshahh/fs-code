import * as pty from 'node-pty'
import type { IPty } from 'node-pty'
import type { BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { IPC } from '../shared/types'
import type { UIMessage } from '../shared/types'
import { getClaudePath } from './auth'
import { log } from './logger'

// ── Terminal phase detection ──
// Parses raw Claude CLI output to emit synthetic UIMessages so the
// JourneyBar can track thinking → searching → planning → coding phases.
//
// Key design: only match tool lines that start with a CLI bullet marker
// (⏺, ●, ◆, ▶) to avoid false positives from assistant prose.
// Debounce all emissions so the bar never flickers.

const ANSI_RE = /\x1b(?:\[[0-9;?]*[a-zA-Z]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[()][0-9A-Z])/g
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '')
}

function uid(): string {
  return randomUUID().slice(0, 8)
}

class TerminalPhaseParser {
  private emit: (msg: UIMessage) => void
  private onTurnDone: () => void
  private onTurnStart: () => void
  private lineBuf = ''
  private lastToolId: string | null = null
  private lastToolName: string | null = null
  private streamTimer: ReturnType<typeof setTimeout> | null = null
  private streamingId: string | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private turnActive = false
  /** After detecting the prompt, suppress emissions until real assistant activity appears */
  private waitingForInput = false

  /** Debounce: hold emissions for a short window so rapid tool→text→tool doesn't flicker */
  private pendingEmit: UIMessage | null = null
  private emitTimer: ReturnType<typeof setTimeout> | null = null
  private readonly EMIT_DELAY = 80 // ms — imperceptible but absorbs rapid state changes

  // ── Detection patterns ──

  // Only match tool lines that begin with a CLI bullet marker.
  // The Claude CLI always prefixes tool calls with one of these characters.
  // This prevents "I'll Read the file" in prose from triggering.
  private static readonly TOOL_RE = /^[\s]*[⏺●◆▶]\s*(Read|Edit|Write|MultiEdit|Bash|Grep|Glob|Agent|WebSearch|WebFetch|Skill|NotebookEdit|TodoRead|TodoWrite|AskUserQuestion|Task|Search|ListFiles|LS)\b/

  // Claude input prompt — the ❯ character (U+276F) optionally followed by
  // non-breaking space (U+00A0) and/or regular whitespace.
  private static readonly CLAUDE_PROMPT_RE = /^[❯]\s*$/

  // Permission / approval prompts — require the specific CLI format:
  // "Allow <tool>?" or "Allow once" or "(Y)es / (N)o" style
  private static readonly WAITING_RE = /(?:^|\s)(?:Allow .+\?|Approve .+\?|\([Yy]\)es\s*\/\s*\([Nn]\)o|\([Aa]\)llow|\([Dd]\)eny)/

  constructor(
    emit: (msg: UIMessage) => void,
    onTurnDone: () => void,
    onTurnStart: () => void,
  ) {
    this.emit = emit
    this.onTurnDone = onTurnDone
    this.onTurnStart = onTurnStart
  }

  feed(rawData: string) {
    const clean = stripAnsi(rawData)
    this.lineBuf += clean

    const lines = this.lineBuf.split(/\r?\n/)
    this.lineBuf = lines.pop() || ''

    for (const line of lines) {
      this.processLine(line)
    }

    // Partial buffer — check for prompt first (prompt line has no trailing \n),
    // then treat remaining text as streaming if no tool marker present.
    const partialTrimmed = this.lineBuf.replace(/\u00A0/g, ' ').trim()
    if (TerminalPhaseParser.CLAUDE_PROMPT_RE.test(partialTrimmed)) {
      this.processLine(partialTrimmed)
      this.lineBuf = ''
    } else if (partialTrimmed.length > 2 && !TerminalPhaseParser.TOOL_RE.test(this.lineBuf) && !this.waitingForInput) {
      this.emitStreaming(partialTrimmed)
    }

    this.resetIdleTimer()
  }

  private processLine(line: string) {
    const trimmed = line.replace(/\u00A0/g, ' ').trim()
    if (!trimmed) return

    // ── Tool use (requires bullet marker prefix) ──
    const toolMatch = trimmed.match(TerminalPhaseParser.TOOL_RE)
    if (toolMatch) {
      const toolName = this.normalizeTool(toolMatch[1])
      this.waitingForInput = false

      if (!this.turnActive) {
        this.turnActive = true
        this.onTurnStart()
      }

      // Close previous tool
      if (this.lastToolId) {
        this.debouncedEmit({ id: uid(), type: 'tool-result', toolUseId: this.lastToolId, output: '', ts: Date.now() })
      }
      this.clearStreaming()

      const toolUseId = uid()
      this.lastToolId = toolUseId
      this.lastToolName = toolName
      this.debouncedEmit({
        id: uid(), type: 'tool-use', toolName, toolUseId,
        input: this.extractInput(trimmed, toolName),
        ts: Date.now(),
      })
      return
    }

    // ── Permission / approval prompt ──
    if (TerminalPhaseParser.WAITING_RE.test(trimmed)) {
      this.waitingForInput = false
      if (this.lastToolId) {
        this.debouncedEmit({ id: uid(), type: 'tool-result', toolUseId: this.lastToolId, output: '', ts: Date.now() })
      }
      this.clearStreaming()
      const toolUseId = uid()
      this.lastToolId = toolUseId
      this.lastToolName = 'AskUserQuestion'
      this.debouncedEmit({
        id: uid(), type: 'tool-use', toolName: 'AskUserQuestion', toolUseId,
        input: { question: trimmed },
        ts: Date.now(),
      })
      return
    }

    // ── Claude prompt → turn done ──
    if (TerminalPhaseParser.CLAUDE_PROMPT_RE.test(trimmed)) {
      if (this.lastToolId) {
        this.flushEmit()
        this.emit({ id: uid(), type: 'tool-result', toolUseId: this.lastToolId, output: '', ts: Date.now() })
        this.lastToolId = null
        this.lastToolName = null
      }
      this.clearStreaming()
      if (this.turnActive) {
        this.turnActive = false
        this.emit({ id: uid(), type: 'result', cost: 0, duration: 0, numTurns: 0, ts: Date.now() })
        this.onTurnDone()
      }
      this.waitingForInput = true
      return
    }

    // ── Assistant text (only when no tool is open) ──
    if (!this.lastToolId) {
      // A complete line of text (not partial keystrokes) clears waitingForInput —
      // this means the assistant has started responding with prose.
      if (this.waitingForInput && trimmed.length > 3) {
        this.waitingForInput = false
      }
      if (!this.waitingForInput) {
        if (!this.turnActive) {
          this.turnActive = true
          this.onTurnStart()
        }
        this.emitStreaming(trimmed)
      }
    }
  }

  // ── Debounced emission ──
  // Holds the most recent message for EMIT_DELAY ms before sending.
  // If a new message arrives within the window, the old one is replaced.
  // This absorbs rapid tool→text→tool transitions into a single smooth change.

  private debouncedEmit(msg: UIMessage) {
    this.pendingEmit = msg
    if (!this.emitTimer) {
      this.emitTimer = setTimeout(() => {
        this.flushEmit()
      }, this.EMIT_DELAY)
    }
  }

  private flushEmit() {
    if (this.emitTimer) { clearTimeout(this.emitTimer); this.emitTimer = null }
    if (this.pendingEmit) {
      this.emit(this.pendingEmit)
      this.pendingEmit = null
    }
  }

  private emitStreaming(text: string) {
    if (this.streamTimer) clearTimeout(this.streamTimer)
    if (!this.streamingId) this.streamingId = uid()

    const streamId = this.streamingId
    this.emit({ id: streamId, type: 'assistant', text, isStreaming: true, ts: Date.now() })

    this.streamTimer = setTimeout(() => {
      // Only close streaming if the same stream is still active —
      // prevents a stale timer from emitting isStreaming:false into a new turn.
      if (this.streamingId === streamId) {
        this.emit({ id: streamId, type: 'assistant', text, isStreaming: false, ts: Date.now() })
        this.streamingId = null
      }
      this.streamTimer = null
    }, 600)
  }

  private clearStreaming() {
    if (this.streamTimer) { clearTimeout(this.streamTimer); this.streamTimer = null }
    this.streamingId = null
  }

  private resetIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      if (this.lastToolId) {
        this.emit({ id: uid(), type: 'tool-result', toolUseId: this.lastToolId, output: '', ts: Date.now() })
        this.lastToolId = null
        this.lastToolName = null
      }
    }, 3000)
  }

  private normalizeTool(name: string): string {
    const map: Record<string, string> = { Search: 'Grep', ListFiles: 'Glob', LS: 'Glob', Task: 'Agent' }
    return map[name] || name
  }

  private extractInput(line: string, toolName: string): Record<string, unknown> {
    const parenMatch = line.match(new RegExp(`${toolName}\\(([^)]+)\\)`))
    const arg = parenMatch?.[1]?.trim() || line.match(new RegExp(`${toolName}\\s+(.+)`))?.[1]?.trim()
    if (!arg) return {}
    if (toolName === 'Bash') return { command: arg }
    if (toolName === 'Grep' || toolName === 'Glob') return { pattern: arg }
    return { file_path: arg }
  }

  dispose() {
    if (this.streamTimer) clearTimeout(this.streamTimer)
    if (this.idleTimer) clearTimeout(this.idleTimer)
    if (this.emitTimer) clearTimeout(this.emitTimer)
  }
}

interface TerminalEntry {
  id: string
  proc: IPty
  buffer: string
  /** Queue of data to write once shell is ready (first prompt seen) */
  pendingWrites: string[]
  /** Whether the shell has printed its first prompt (ready to accept input) */
  shellReady: boolean
  /** Timer ID for shell-ready timeout fallback */
  readyTimeoutId: ReturnType<typeof setTimeout> | null
  /** Phase parser for claude-mode terminals (null for plain shells) */
  phaseParser: TerminalPhaseParser | null
}

const terminals = new Map<string, TerminalEntry>()
// agentId → terminalId  (persistent mapping)
const agentTerminals = new Map<string, string>()
let mainWindow: BrowserWindow | null = null

const MAX_BUFFER = 50_000 // keep ~50KB scrollback per terminal (50K × 9 = 450KB total)

export function setMainWindow(win: BrowserWindow) {
  mainWindow = win
}

/**
 * Get or create a terminal for an agent.
 * If a live terminal already exists for this agentId, return it (idempotent).
 * Returns { terminalId, isNew }.
 */
export function getOrCreateTerminal(agentId: string, cwd: string): { terminalId: string; isNew: boolean } {
  // Check for existing live terminal
  const existingId = agentTerminals.get(agentId)
  if (existingId) {
    const entry = terminals.get(existingId)
    if (entry) {
      return { terminalId: existingId, isNew: false }
    }
    // Terminal died — clean up stale mapping
    agentTerminals.delete(agentId)
  }

  // Create new terminal
  const id = randomUUID().slice(0, 8)

  let shell: string
  let args: string[]
  if (process.platform === 'win32') {
    const useWSL = cwd.startsWith('/') || cwd.startsWith('\\\\wsl')
    if (useWSL) {
      shell = 'wsl.exe'
      args = []
    } else {
      shell = process.env.COMSPEC || 'cmd.exe'
      args = []
    }
  } else {
    shell = process.env.SHELL || '/bin/bash'
    args = ['-l']
  }

  const proc = pty.spawn(shell, args, {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd,
    env: process.env as Record<string, string>,
  })

  const entry: TerminalEntry = {
    id, proc, buffer: '',
    pendingWrites: [],
    shellReady: false,
    readyTimeoutId: null,
    phaseParser: null,
  }
  terminals.set(id, entry)
  agentTerminals.set(agentId, id)

  // Batch terminal data into 50ms windows with a 16KB cap to prevent IPC flooding.
  // At 9 terminals under heavy output (npm install, test runs), raw data can exceed 9MB/s.
  // Wider window + lower cap keeps renderer responsive even at 2-3× load.
  const MAX_PENDING = 16_000 // 16KB max per IPC message (16K × 9 = 144KB/flush max)
  const FLUSH_MS = 50        // 50ms batch window (vs 32ms before — fewer IPC calls)
  let pendingData = ''
  let flushTimer: ReturnType<typeof setTimeout> | null = null

  proc.onData((data: string) => {
    // Append to buffer (circular — trim if too large)
    entry.buffer += data
    if (entry.buffer.length > MAX_BUFFER) {
      entry.buffer = entry.buffer.slice(-MAX_BUFFER)
    }

    // Feed phase parser (claude-mode terminals only)
    if (entry.phaseParser) {
      entry.phaseParser.feed(data)
    }

    // Detect shell readiness: look for common prompt endings ($, %, >, #)
    // This fires once — drains any queued writes (like the claude command)
    if (!entry.shellReady) {
      // Heuristic: shell has output something ending with a prompt character
      const trimmed = data.trimEnd()
      if (trimmed.endsWith('$') || trimmed.endsWith('%') || trimmed.endsWith('>') || trimmed.endsWith('#') || data.includes('\x1b]')) {
        markShellReady(entry)
      }
    }

    pendingData += data
    // If pending data is huge, truncate to tail (keep most recent output)
    if (pendingData.length > MAX_PENDING) {
      pendingData = pendingData.slice(-MAX_PENDING)
    }
    if (!flushTimer) {
      flushTimer = setTimeout(() => {
        if (pendingData) {
          if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.TERM_DATA, { terminalId: id, data: pendingData })
          pendingData = ''
        }
        flushTimer = null
      }, FLUSH_MS)
    }
  })

  proc.onExit(({ exitCode }) => {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
    if (entry.readyTimeoutId) { clearTimeout(entry.readyTimeoutId); entry.readyTimeoutId = null }
    if (entry.phaseParser) { entry.phaseParser.dispose(); entry.phaseParser = null }
    // Flush any remaining data before closing
    if (pendingData && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC.TERM_DATA, { terminalId: id, data: pendingData })
      pendingData = ''
    }
    terminals.delete(id)
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.TERM_EXIT, { terminalId: id, code: exitCode })
  })

  return { terminalId: id, isNew: true }
}

/** Mark shell as ready and drain pending writes */
function markShellReady(entry: TerminalEntry) {
  if (entry.shellReady) return
  entry.shellReady = true
  if (entry.readyTimeoutId) {
    clearTimeout(entry.readyTimeoutId)
    entry.readyTimeoutId = null
  }
  // Drain pending writes
  for (const data of entry.pendingWrites) {
    entry.proc.write(data)
  }
  entry.pendingWrites = []
}

/** Get buffered output for a terminal (for replaying on reattach). */
export function getBuffer(terminalId: string): string {
  return terminals.get(terminalId)?.buffer || ''
}

export function writeToTerminal(terminalId: string, data: string) {
  const entry = terminals.get(terminalId)
  entry?.proc.write(data)
}

/** Write data to the terminal belonging to an agent (by agentId). */
export function writeToAgentTerminal(agentId: string, data: string) {
  const terminalId = agentTerminals.get(agentId)
  if (terminalId) writeToTerminal(terminalId, data)
}

export function resizeTerminal(terminalId: string, cols: number, rows: number) {
  const entry = terminals.get(terminalId)
  if (entry && cols > 0 && rows > 0) {
    entry.proc.resize(cols, rows)
  }
}

/** Close a specific terminal (kills the PTY). */
export function closeTerminal(terminalId: string) {
  const entry = terminals.get(terminalId)
  if (entry) {
    if (entry.readyTimeoutId) clearTimeout(entry.readyTimeoutId)
    if (entry.phaseParser) { entry.phaseParser.dispose(); entry.phaseParser = null }
    entry.proc.kill()
    terminals.delete(terminalId)
  }
  // Clean up agent mapping if it pointed here
  for (const [aid, tid] of agentTerminals) {
    if (tid === terminalId) {
      agentTerminals.delete(aid)
      break
    }
  }
}

/** Close the terminal belonging to an agent (called when agent is closed). */
export function closeAgentTerminal(agentId: string) {
  const terminalId = agentTerminals.get(agentId)
  if (terminalId) {
    closeTerminal(terminalId)
  }
  agentTerminals.delete(agentId)
}

export function closeAll() {
  for (const [, entry] of terminals) {
    if (entry.readyTimeoutId) clearTimeout(entry.readyTimeoutId)
    entry.proc.kill()
  }
  terminals.clear()
  agentTerminals.clear()
}

// ── Claude-ex MCP config ──

const CODEX_MCP_ENTRY = {
  type: 'stdio' as const,
  command: 'claude-ex',
  args: ['mcp'],
}

const CODEX_HOOKS = {
  SessionStart: [
    { matcher: '', hooks: [{ type: 'command', command: 'claude-ex brief', timeout: 5000 }] },
  ],
  PreToolUse: [
    { matcher: 'Write', hooks: [{ type: 'command', command: 'claude-ex pre-edit "$(jq -r \'.tool_input.file_path\')"', timeout: 3000 }] },
    { matcher: 'Edit', hooks: [{ type: 'command', command: 'claude-ex pre-edit "$(jq -r \'.tool_input.file_path\')"', timeout: 3000 }] },
    { matcher: 'MultiEdit', hooks: [{ type: 'command', command: 'claude-ex pre-edit "$(jq -r \'.tool_input.file_path\')"', timeout: 3000 }] },
    { matcher: 'Read', hooks: [{ type: 'command', command: 'claude-ex pre-edit "$(jq -r \'.tool_input.file_path\')"', timeout: 3000 }] },
  ],
  PostToolUse: [
    { matcher: 'Write', hooks: [{ type: 'command', command: 'claude-ex post-edit "$(jq -r \'.tool_input.file_path\')"', timeout: 5000 }] },
    { matcher: 'Edit', hooks: [{ type: 'command', command: 'claude-ex post-edit "$(jq -r \'.tool_input.file_path\')"', timeout: 5000 }] },
    { matcher: 'MultiEdit', hooks: [{ type: 'command', command: 'claude-ex post-edit "$(jq -r \'.tool_input.file_path\')"', timeout: 5000 }] },
  ],
}

// Track which cwds we've already configured (avoid repeated disk I/O)
const configuredCwds = new Set<string>()

/**
 * Ensure the project has .mcp.json and .claude/settings.json configured
 * for claude-ex code intelligence. Non-destructive — merges into existing files.
 * Idempotent: skips if already configured this session.
 */
export function ensureClaudeExConfig(cwd: string): void {
  if (configuredCwds.has(cwd)) return
  try {
    // .mcp.json — add codex MCP server entry
    const mcpPath = join(cwd, '.mcp.json')
    let mcpConfig: any = {}
    if (existsSync(mcpPath)) {
      try { mcpConfig = JSON.parse(readFileSync(mcpPath, 'utf-8')) } catch { /* corrupt — overwrite */ }
    }
    if (!mcpConfig.mcpServers) mcpConfig.mcpServers = {}
    if (!mcpConfig.mcpServers.codex) {
      mcpConfig.mcpServers.codex = CODEX_MCP_ENTRY
      writeFileSync(mcpPath, JSON.stringify(mcpConfig, null, 2) + '\n')
      log.info('terminal', `wrote codex MCP config to ${mcpPath}`)
    }

    // .claude/settings.json — add permissions + hooks
    const claudeDir = join(cwd, '.claude')
    const settingsPath = join(claudeDir, 'settings.json')
    let settings: any = {}
    if (existsSync(settingsPath)) {
      try { settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) } catch { /* corrupt — overwrite */ }
    } else {
      mkdirSync(claudeDir, { recursive: true })
    }
    // Merge permissions
    if (!settings.permissions) settings.permissions = {}
    if (!settings.permissions.allow) settings.permissions.allow = []
    if (!settings.permissions.allow.includes('mcp__codex__*')) {
      settings.permissions.allow.push('mcp__codex__*')
    }
    // Merge hooks (only if not already present — don't clobber user customizations)
    let needsWrite = false
    if (!settings.hooks) {
      settings.hooks = CODEX_HOOKS
      needsWrite = true
    }
    if (needsWrite || !settings.permissions.allow.includes('mcp__codex__*')) {
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n')
      log.info('terminal', `wrote codex settings to ${settingsPath}`)
    }

    configuredCwds.add(cwd)
  } catch (err) {
    log.warn('terminal', `ensureClaudeExConfig failed for ${cwd}: ${err}`)
  }
}

/**
 * Create a terminal that launches `claude` CLI directly.
 * The shell stays alive after claude exits (ctrl+C) so the user can re-run it.
 * Returns { terminalId, isNew } same as getOrCreateTerminal.
 */
export function createClaudeTerminal(
  agentId: string,
  cwd: string,
  opts?: { resume?: string },
): { terminalId: string; isNew: boolean } {
  // Ensure claude-ex MCP config exists in the project
  ensureClaudeExConfig(cwd)

  // If agent already has a live terminal, return it
  const existingId = agentTerminals.get(agentId)
  if (existingId) {
    const entry = terminals.get(existingId)
    if (entry) {
      return { terminalId: existingId, isNew: false }
    }
    agentTerminals.delete(agentId)
  }

  // Create a shell terminal
  const result = getOrCreateTerminal(agentId, cwd)
  const entry = terminals.get(result.terminalId)
  if (!entry) return result

  // Attach phase parser to emit synthetic UIMessages for the journey bar.
  const sendMsg = (msg: UIMessage) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC.AGENT_MESSAGE, { agentId, ...msg })
    }
  }
  const sendSessionEnd = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC.AGENT_SESSION_ENDED, { agentId, sessionId: uid() })
    }
  }
  const sendSessionStart = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC.AGENT_SESSION_STARTED, { agentId, sessionId: uid() })
    }
  }
  entry.phaseParser = new TerminalPhaseParser(sendMsg, sendSessionEnd, sendSessionStart)
  // Mark session active right away so the journey bar shows "Thinking" while claude boots
  sendSessionStart()

  // Build the claude command
  const claudePath = getClaudePath()
  const bin = claudePath || 'claude'

  let cmd = bin
  if (opts?.resume) {
    cmd += ` --resume ${opts.resume}`
  }
  cmd += '\n'

  // Queue the command — it will be written once the shell prompt is detected.
  // This is more reliable than a fixed timeout, especially under load.
  entry.pendingWrites.push(cmd)

  // Safety fallback: if shell-ready detection misses (unusual prompt format),
  // force-write after 2 seconds
  entry.readyTimeoutId = setTimeout(() => {
    entry.readyTimeoutId = null
    markShellReady(entry)
  }, 2000)

  return result
}

/**
 * Create a terminal that launches the OpenAI `codex` CLI directly.
 * Uses --no-alt-screen so it works inline in the embedded terminal.
 * Returns { terminalId, isNew } same as getOrCreateTerminal.
 */
export function createCodexTerminal(
  agentId: string,
  cwd: string,
): { terminalId: string; isNew: boolean } {
  // If agent already has a live terminal, return it
  const existingId = agentTerminals.get(agentId)
  if (existingId) {
    const entry = terminals.get(existingId)
    if (entry) {
      return { terminalId: existingId, isNew: false }
    }
    agentTerminals.delete(agentId)
  }

  // Create a shell terminal
  const result = getOrCreateTerminal(agentId, cwd)
  const entry = terminals.get(result.terminalId)
  if (!entry) return result

  // Build the codex command — use --no-alt-screen for inline mode
  const cmd = 'codex --no-alt-screen\n'

  // Queue the command — it will be written once the shell prompt is detected.
  entry.pendingWrites.push(cmd)

  // Safety fallback: if shell-ready detection misses, force-write after 2 seconds
  entry.readyTimeoutId = setTimeout(() => {
    entry.readyTimeoutId = null
    markShellReady(entry)
  }, 2000)

  return result
}
