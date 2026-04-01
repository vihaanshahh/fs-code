import * as pty from 'node-pty'
import type { IPty } from 'node-pty'
import type { BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync, watch, readdirSync, openSync, readSync, fstatSync, closeSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { IPC } from '../shared/types'
import type { UIMessage, AgentPhase, ActiveToolInfo } from '../shared/types'
import { getClaudePath } from './auth'
import { log } from './logger'

// ── Session JSONL watcher ──
// Instead of parsing raw ANSI terminal output with fragile regexes,
// we read the structured JSONL that the Claude CLI writes to disk.
// The CLI writes session data to ~/.claude/projects/<project-hash>/<sessionId>.jsonl
// in real-time. Each line is a JSON object with perfect tool_use, tool_result,
// and assistant text data — no guessing required.

function uid(): string {
  return randomUUID().slice(0, 8)
}

/** Convert a cwd path to the Claude CLI's project directory name */
function cwdToProjectDir(cwd: string): string {
  return cwd.replace(/\//g, '-').replace(/^-/, '-')
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function journeyFileForAgent(agentId: string): string {
  return join(tmpdir(), `fluidstate-journey-${agentId}.jsonl`)
}

/**
 * Watches the Claude CLI's session JSONL file for structured events.
 * Replaces the old TerminalPhaseParser that parsed ANSI terminal output.
 */
class SessionJsonlWatcher {
  private emit: (msg: UIMessage) => void
  private emitPhase: (phase: AgentPhase, detail: string, activeTool?: ActiveToolInfo) => void
  private onTurnDone: () => void
  private onTurnStart: () => void
  private cwd: string

  private sessionId: string | null = null
  private jsonlPath: string | null = null
  private fileOffset = 0
  private partialLine = ''
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private sessionPollTimer: ReturnType<typeof setInterval> | null = null
  private parentDirWatcher: ReturnType<typeof watch> | null = null
  private projectDirWatcher: ReturnType<typeof watch> | null = null
  private disposed = false
  private turnActive = false
  private launchTime: number
  private lastAssistantId: string | null = null
  private openToolIds = new Map<string, string>() // real toolUseId → our emitted toolUseId
  private observedFiles = new Map<string, { size: number; mtimeMs: number; birthtimeMs: number }>()
  private currentPhase: { phase: AgentPhase; detail: string; toolUseId?: string } | null = null

  constructor(
    emit: (msg: UIMessage) => void,
    emitPhase: (phase: AgentPhase, detail: string, activeTool?: ActiveToolInfo) => void,
    onTurnDone: () => void,
    onTurnStart: () => void,
    cwd: string,
  ) {
    this.emit = emit
    this.emitPhase = emitPhase
    this.onTurnDone = onTurnDone
    this.onTurnStart = onTurnStart
    this.cwd = cwd
    this.launchTime = Date.now()

    this.startSessionDiscovery()
  }

  private startSessionDiscovery() {
    const projectDir = cwdToProjectDir(this.cwd)
    const projectsRoot = join(homedir(), '.claude', 'projects')
    const jsonlDir = join(homedir(), '.claude', 'projects', projectDir)
    log.info('jsonl-watcher', `looking for session in ${jsonlDir} (cwd=${this.cwd})`)

    const scan = () => this.scanForSession(jsonlDir)

    if (existsSync(projectsRoot)) {
      try {
        this.parentDirWatcher = watch(projectsRoot, (_eventType, filename) => {
          if (!filename || filename.toString() === projectDir) {
            this.attachProjectWatcher(jsonlDir)
            scan()
          }
        })
        this.parentDirWatcher.on('error', () => {
          this.parentDirWatcher?.close()
          this.parentDirWatcher = null
        })
      } catch (err) {
        log.warn('jsonl-watcher', `failed to watch projects root ${projectsRoot}: ${err}`)
      }
    }

    this.attachProjectWatcher(jsonlDir)
    scan()
    this.sessionPollTimer = setInterval(scan, 250)

    setTimeout(() => {
      if (!this.sessionId && this.sessionPollTimer) {
        clearInterval(this.sessionPollTimer)
        this.sessionPollTimer = null
        log.warn('jsonl-watcher', 'session discovery timed out after 120s')
      }
    }, 120000)
  }

  private attachProjectWatcher(jsonlDir: string) {
    if (this.projectDirWatcher || !existsSync(jsonlDir)) return
    try {
      this.projectDirWatcher = watch(jsonlDir, () => {
        this.scanForSession(jsonlDir)
        this.readNewLines()
      })
      this.projectDirWatcher.on('error', () => {
        this.projectDirWatcher?.close()
        this.projectDirWatcher = null
      })
    } catch (err) {
      log.warn('jsonl-watcher', `failed to watch project dir ${jsonlDir}: ${err}`)
    }
  }

  private scanForSession(jsonlDir: string) {
    if (this.disposed || this.sessionId || !existsSync(jsonlDir)) return
    try {
      const files = readdirSync(jsonlDir).filter(f => f.endsWith('.jsonl'))
      if (files.length === 0) return

      let bestCandidate: { name: string; offset: number; score: number; birthtimeMs: number; mtimeMs: number } | null = null

      for (const fileName of files) {
        try {
          const fullPath = join(jsonlDir, fileName)
          const fd = openSync(fullPath, 'r')
          const stat = fstatSync(fd)
          closeSync(fd)

          const prev = this.observedFiles.get(fileName)
          const info = {
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            birthtimeMs: stat.birthtimeMs || stat.ctimeMs,
          }
          this.observedFiles.set(fileName, info)

          let score = 0
          let offset = stat.size

          if (info.birthtimeMs >= this.launchTime - 1000) {
            score = 4
            offset = 0
          } else if (!prev && info.mtimeMs >= this.launchTime - 1000) {
            score = 3
            offset = 0
          } else if (prev && info.size > prev.size) {
            score = 2
            offset = prev.size
          } else if (info.mtimeMs >= this.launchTime - 1000) {
            score = 1
            offset = stat.size
          }

          if (!bestCandidate || score > bestCandidate.score || (score === bestCandidate.score && info.mtimeMs > bestCandidate.mtimeMs)) {
            bestCandidate = { name: fileName, offset, score, birthtimeMs: info.birthtimeMs, mtimeMs: info.mtimeMs }
          }
        } catch {
          continue
        }
      }

      if (!bestCandidate || bestCandidate.score <= 0) return

      this.sessionId = bestCandidate.name.replace('.jsonl', '')
      this.jsonlPath = join(jsonlDir, bestCandidate.name)
      this.fileOffset = bestCandidate.offset
      this.partialLine = ''
      log.info(
        'jsonl-watcher',
        `attached session ${this.sessionId} score=${bestCandidate.score} offset=${this.fileOffset} birth=${new Date(bestCandidate.birthtimeMs).toISOString()} mtime=${new Date(bestCandidate.mtimeMs).toISOString()}`,
      )
      this.startFilePolling()
    } catch (err) {
      log.warn('jsonl-watcher', `session discovery error: ${err}`)
    }
  }

  private startFilePolling() {
    if (this.sessionPollTimer) {
      clearInterval(this.sessionPollTimer)
      this.sessionPollTimer = null
    }

    // Poll at 2s — the file watcher handles the fast path.
    // Before session discovery we polled at 250ms; now that session is found,
    // this is just a fallback for missed fs events.
    this.pollTimer = setInterval(() => {
      if (this.disposed) return
      this.readNewLines()
    }, 2000)

    // Also read immediately
    this.readNewLines()
  }

  private readNewLines() {
    if (!this.jsonlPath || !existsSync(this.jsonlPath)) return

    try {
      const fd = openSync(this.jsonlPath, 'r')
      try {
        const stat = fstatSync(fd)
        if (stat.size <= this.fileOffset) return

        const buf = Buffer.alloc(stat.size - this.fileOffset)
        readSync(fd, buf, 0, buf.length, this.fileOffset)
        this.fileOffset = stat.size

        const text = this.partialLine + buf.toString('utf-8')
        const lines = text.split('\n')
        this.partialLine = lines.pop() || ''

        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const event = JSON.parse(line)
            this.processEvent(event)
          } catch { /* skip malformed lines */ }
        }
      } finally {
        closeSync(fd)
      }
    } catch (err) {
      log.warn('jsonl-watcher', `read error: ${err}`)
    }
  }

  private setPhase(phase: AgentPhase, detail: string, activeTool?: ActiveToolInfo) {
    const toolUseId = activeTool?.toolUseId
    const prev = this.currentPhase
    if (prev && prev.phase === phase && prev.detail === detail && prev.toolUseId === toolUseId) return
    this.currentPhase = { phase, detail, toolUseId }
    this.emitPhase(phase, detail, activeTool)
  }

  /** Called by the journey hook watcher when a new phase is emitted from hooks */
  noteHookPhase(phase: AgentPhase) {
    if (phase !== 'idle' && phase !== 'done') {
      this.seenTurn = true
      if (!this.turnActive) {
        this.turnActive = true
        this.onTurnStart()
      }
    }
  }

  private processEvent(event: any) {
    const ts = Date.now()

    if (event.type === 'assistant' && event.message?.content) {
      if (!this.turnActive) {
        this.turnActive = true
        this.seenTurn = true
        this.onTurnStart()
        // Phase is driven by hooks (UserPromptSubmit/PreToolUse/PermissionRequest),
        // not by JSONL events. Do not call setPhase here.
      }

      for (const block of event.message.content) {
        if (block.type === 'tool_use') {
          this.lastAssistantId = null

          const ourId = uid()
          this.openToolIds.set(block.id, ourId)
          // No setPhase here — PreToolUse hook already fired before tool execution
          this.emit({
            id: uid(), type: 'tool-use',
            toolName: block.name,
            toolUseId: ourId,
            input: block.input || {},
            ts,
          })
        } else if (block.type === 'text' && block.text) {
          const id = this.lastAssistantId || uid()
          this.lastAssistantId = id
          // No setPhase here — hooks drive phase, not assistant text events
          this.emit({
            id, type: 'assistant',
            text: block.text,
            isStreaming: !event.message.stop_reason,
            ts,
          })
        }
      }

      if (event.message.stop_reason === 'end_turn') {
        this.lastAssistantId = null
        for (const [, ourId] of this.openToolIds) {
          this.emit({ id: uid(), type: 'tool-result', toolUseId: ourId, output: '', ts })
        }
        this.openToolIds.clear()

        if (this.turnActive) {
          this.turnActive = false
          this.setPhase('done', 'Completed')
          this.emit({ id: uid(), type: 'result', cost: 0, duration: 0, numTurns: 0, ts })
          this.onTurnDone()
        }
      } else if (event.message.stop_reason) {
        this.lastAssistantId = null
      }
    }

    if (event.type === 'user' && event.message?.content) {
      for (const block of event.message.content) {
        if (block.type === 'tool_result' && block.tool_use_id) {
          const ourId = this.openToolIds.get(block.tool_use_id)
          if (ourId) {
            const output = typeof block.content === 'string'
              ? block.content
              : Array.isArray(block.content)
                ? block.content.map((c: any) => c.text || '').join('\n')
                : ''
            this.emit({
              id: uid(), type: 'tool-result',
              toolUseId: ourId,
              output: output.slice(0, 2000),
              ts,
            })
            this.openToolIds.delete(block.tool_use_id)
          }
        }
      }
    }

    if (event.type === 'result') {
      for (const [, ourId] of this.openToolIds) {
        this.emit({ id: uid(), type: 'tool-result', toolUseId: ourId, output: '', ts })
      }
      this.openToolIds.clear()
      this.lastAssistantId = null

      if (this.turnActive) {
        this.turnActive = false
        this.setPhase('done', 'Completed')
        this.emit({
          id: uid(), type: 'result',
          cost: event.total_cost_usd || 0,
          duration: event.duration_ms || 0,
          numTurns: event.num_turns || 0,
          ts,
        })
        this.onTurnDone()
      }
    }

    if (event.type === 'rate_limit_event' && event.rate_limit_info) {
      const info = event.rate_limit_info
      this.emit({
        id: uid(), type: 'usage',
        utilization: 0,
        resetsAt: info.resetsAt ? info.resetsAt * 1000 : null,
        limitType: info.rateLimitType || '',
        status: info.status || '',
        ts,
      })
    }
  }

  /**
   * Feed raw PTY data. The only thing we watch for here is the Claude Code
   * input prompt (❯) reappearing after work finishes. This covers interrupted
   * tools and permission denials where no JSONL event fires.
   */
  feedTerminalData(rawData: string) {
    // Strip ANSI escape sequences
    const clean = rawData.replace(/\x1b(?:\[[0-9;?]*[a-zA-Z]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[()][0-9A-Z])/g, '').replace(/\x0f|\x0e/g, '')
    this.termBuf += clean
    if (this.termBuf.length > 800) this.termBuf = this.termBuf.slice(-800)

    // ⏺ = Claude Code tool bullet (appears when a tool runs)
    // ⎿ = Claude Code tool-result indent (appears in same chunk as "Interrupted")
    // Both appear well before ❯ — using them to mark turn active avoids the
    // 200ms hook-watcher polling race for the interrupted-tool case.
    if (!this.seenTurn && /[⎿⏺]/.test(this.termBuf)) {
      this.seenTurn = true
      if (!this.turnActive) {
        this.turnActive = true
        this.onTurnStart()
      }
    }

    // ❯ at the start of a line = Claude Code returned to its interactive prompt.
    // Emit done if we have an active turn and have seen work happen.
    if (this.seenTurn && this.turnActive && /(?:^|\r|\n)❯/.test(this.termBuf)) {
      this.turnActive = false
      this.seenTurn = false
      this.setPhase('done', 'Completed')
      this.emit({ id: uid(), type: 'result', cost: 0, duration: 0, numTurns: 0, ts: Date.now() })
      this.onTurnDone()
      this.termBuf = ''
    }
  }

  private termBuf = ''
  private seenTurn = false

  dispose() {
    this.disposed = true
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null }
    if (this.sessionPollTimer) { clearInterval(this.sessionPollTimer); this.sessionPollTimer = null }
    if (this.parentDirWatcher) { this.parentDirWatcher.close(); this.parentDirWatcher = null }
    if (this.projectDirWatcher) { this.projectDirWatcher.close(); this.projectDirWatcher = null }
  }
}

class JourneyHookWatcher {
  private filePath: string
  private emitPhase: (phase: AgentPhase, detail: string, activeTool?: ActiveToolInfo, startedAt?: number) => void
  private fileOffset = 0
  private partialLine = ''
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private fileWatcher: ReturnType<typeof watch> | null = null
  private disposed = false
  private fileFound = false

  constructor(
    filePath: string,
    emitPhase: (phase: AgentPhase, detail: string, activeTool?: ActiveToolInfo, startedAt?: number) => void,
  ) {
    this.filePath = filePath
    this.emitPhase = emitPhase

    try { unlinkSync(this.filePath) } catch { /* ignore */ }
    this.attach()
  }

  private attach() {
    const read = () => {
      if (this.disposed) return
      this.readNewLines()
    }
    this.pollTimer = setInterval(read, 200)
    try {
      this.fileWatcher = watch(tmpdir(), (_eventType, filename) => {
        if (this.disposed) return
        if (!filename || join(tmpdir(), filename.toString()) !== this.filePath) return
        read()
      })
      this.fileWatcher.on('error', () => {
        this.fileWatcher?.close()
        this.fileWatcher = null
      })
    } catch (err) {
      log.warn('journey-hook', `watch failed for ${this.filePath}: ${err}`)
    }
  }

  private readNewLines() {
    if (this.disposed) return
    if (!existsSync(this.filePath)) return

    // After first successful read, slow polling to 500ms (file watcher handles fast path)
    if (!this.fileFound) {
      this.fileFound = true
      if (this.pollTimer) {
        clearInterval(this.pollTimer)
        this.pollTimer = setInterval(() => {
          if (this.disposed) return
          this.readNewLines()
        }, 500)
      }
    }

    try {
      const fd = openSync(this.filePath, 'r')
      try {
        const stat = fstatSync(fd)
        if (stat.size <= this.fileOffset) return
        const buf = Buffer.alloc(stat.size - this.fileOffset)
        readSync(fd, buf, 0, buf.length, this.fileOffset)
        this.fileOffset = stat.size

        const text = this.partialLine + buf.toString('utf8')
        const lines = text.split('\n')
        this.partialLine = lines.pop() || ''

        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const event = JSON.parse(line)
            this.emitPhase(event.phase, event.detail || '', event.activeTool, event.ts)
          } catch {
            continue
          }
        }
      } finally {
        closeSync(fd)
      }
    } catch (err) {
      log.warn('journey-hook', `read failed for ${this.filePath}: ${err}`)
    }
  }

  dispose() {
    this.disposed = true
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null }
    if (this.fileWatcher) { this.fileWatcher.close(); this.fileWatcher = null }
    try { unlinkSync(this.filePath) } catch { /* ignore */ }
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
  /** JSONL session watcher for claude-mode terminals (null for plain shells) */
  jsonlWatcher: SessionJsonlWatcher | null
  journeyHookWatcher: JourneyHookWatcher | null
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
export function getOrCreateTerminal(
  agentId: string,
  cwd: string,
  envOverrides?: Record<string, string>,
): { terminalId: string; isNew: boolean } {
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
    env: {
      ...(process.env as Record<string, string>),
      ...(envOverrides || {}),
    },
  })

  const entry: TerminalEntry = {
    id, proc, buffer: '',
    pendingWrites: [],
    shellReady: false,
    readyTimeoutId: null,
    jsonlWatcher: null,
    journeyHookWatcher: null,
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

    // Feed to JSONL watcher for ❯ prompt detection (interrupt/done fallback)
    if (entry.jsonlWatcher) {
      entry.jsonlWatcher.feedTerminalData(data)
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
    if (entry.jsonlWatcher) { entry.jsonlWatcher.dispose(); entry.jsonlWatcher = null }
    if (entry.journeyHookWatcher) { entry.journeyHookWatcher.dispose(); entry.journeyHookWatcher = null }
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
  if (!entry) return
  entry.proc.write(data)
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
    if (entry.jsonlWatcher) { entry.jsonlWatcher.dispose(); entry.jsonlWatcher = null }
    if (entry.journeyHookWatcher) { entry.journeyHookWatcher.dispose(); entry.journeyHookWatcher = null }
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
    if (entry.jsonlWatcher) { entry.jsonlWatcher.dispose(); entry.jsonlWatcher = null }
    if (entry.journeyHookWatcher) { entry.journeyHookWatcher.dispose(); entry.journeyHookWatcher = null }
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

const JOURNEY_TOOL_MATCHER = 'Read|Write|Edit|MultiEdit|NotebookEdit|Bash|Grep|Glob|Agent|Skill|WebSearch|WebFetch|Ls|Search|ListFiles|Task'
const JOURNEY_HOOK_SCRIPT = join(process.cwd(), 'scripts', 'claude-journey-hook.cjs')

function buildClaudeHooks() {
  const journeyCmd = `node ${shellEscape(JOURNEY_HOOK_SCRIPT)}`
  return {
    SessionStart: [
      { matcher: '', hooks: [{ type: 'command', command: 'claude-ex brief', timeout: 5000 }] },
    ],
    UserPromptSubmit: [
      { matcher: '', hooks: [{ type: 'command', command: journeyCmd, timeout: 2000 }] },
    ],
    PermissionRequest: [
      { matcher: '', hooks: [{ type: 'command', command: journeyCmd, timeout: 2000 }] },
    ],
    Stop: [
      { matcher: '', hooks: [{ type: 'command', command: journeyCmd, timeout: 2000 }] },
    ],
    PreToolUse: [
      { matcher: JOURNEY_TOOL_MATCHER, hooks: [{ type: 'command', command: journeyCmd, timeout: 2000 }] },
      { matcher: 'Write', hooks: [{ type: 'command', command: 'claude-ex pre-edit "$(jq -r \'.tool_input.file_path\')"', timeout: 3000 }] },
      { matcher: 'Edit', hooks: [{ type: 'command', command: 'claude-ex pre-edit "$(jq -r \'.tool_input.file_path\')"', timeout: 3000 }] },
      { matcher: 'MultiEdit', hooks: [{ type: 'command', command: 'claude-ex pre-edit "$(jq -r \'.tool_input.file_path\')"', timeout: 3000 }] },
      { matcher: 'Read', hooks: [{ type: 'command', command: 'claude-ex pre-edit "$(jq -r \'.tool_input.file_path\')"', timeout: 3000 }] },
    ],
    PostToolUse: [
      { matcher: JOURNEY_TOOL_MATCHER, hooks: [{ type: 'command', command: journeyCmd, timeout: 2000 }] },
      { matcher: 'Write', hooks: [{ type: 'command', command: 'claude-ex post-edit "$(jq -r \'.tool_input.file_path\')"', timeout: 5000 }] },
      { matcher: 'Edit', hooks: [{ type: 'command', command: 'claude-ex post-edit "$(jq -r \'.tool_input.file_path\')"', timeout: 5000 }] },
      { matcher: 'MultiEdit', hooks: [{ type: 'command', command: 'claude-ex post-edit "$(jq -r \'.tool_input.file_path\')"', timeout: 5000 }] },
    ],
  }
}

function mergeHookConfig(existing: any, additions: any) {
  const next = { ...(existing || {}) }
  for (const [eventName, matchers] of Object.entries(additions)) {
    const list = Array.isArray(next[eventName]) ? [...next[eventName]] : []
    for (const matcher of matchers as any[]) {
      const matcherKey = JSON.stringify(matcher)
      if (!list.some(item => JSON.stringify(item) === matcherKey)) {
        list.push(matcher)
      }
    }
    next[eventName] = list
  }
  return next
}

const CLAUDE_CONFIG_VERSION = 'journey-v3'
const configuredCwds = new Map<string, string>()

/**
 * Ensure the project has .mcp.json and .claude/settings.json configured
 * for claude-ex code intelligence. Non-destructive — merges into existing files.
 * Idempotent: skips if already configured this session.
 */
export function ensureClaudeExConfig(cwd: string): void {
  if (configuredCwds.get(cwd) === CLAUDE_CONFIG_VERSION) return
  try {
    const claudeHooks = buildClaudeHooks()
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
    // Merge hooks non-destructively so existing project hooks keep working.
    const mergedHooks = mergeHookConfig(settings.hooks, claudeHooks)
    const needsWrite = JSON.stringify(settings.hooks || {}) !== JSON.stringify(mergedHooks)
    settings.hooks = mergedHooks
    if (needsWrite || !settings.permissions.allow.includes('mcp__codex__*')) {
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n')
      log.info('terminal', `wrote codex settings to ${settingsPath}`)
    }

    configuredCwds.set(cwd, CLAUDE_CONFIG_VERSION)
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

  const journeyFile = journeyFileForAgent(agentId)

  // Create a shell terminal with the journey hook environment already attached.
  const result = getOrCreateTerminal(agentId, cwd, {
    FLUIDSTATE_JOURNEY_FILE: journeyFile,
    FLUIDSTATE_AGENT_ID: agentId,
  })
  const entry = terminals.get(result.terminalId)
  if (!entry) return result

  const sendMsg = (msg: UIMessage) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC.AGENT_MESSAGE, { agentId, ...msg })
    }
  }
  const sendPhase = (phase: AgentPhase, detail: string, activeTool?: ActiveToolInfo) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC.AGENT_PHASE, {
        agentId,
        phase,
        detail,
        activeTool,
        startedAt: activeTool?.startTs || Date.now(),
      })
    }
  }
  const sendPhaseWithStart = (phase: AgentPhase, detail: string, activeTool?: ActiveToolInfo, startedAt?: number) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC.AGENT_PHASE, {
        agentId,
        phase,
        detail,
        activeTool,
        startedAt: startedAt || activeTool?.startTs || Date.now(),
      })
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
  entry.jsonlWatcher = new SessionJsonlWatcher(sendMsg, sendPhase, sendSessionEnd, sendSessionStart, cwd)
  entry.journeyHookWatcher = new JourneyHookWatcher(journeyFile, (phase, detail, activeTool, startedAt) => {
    sendPhaseWithStart(phase, detail, activeTool, startedAt)
    entry.jsonlWatcher?.noteHookPhase(phase)
  })

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
