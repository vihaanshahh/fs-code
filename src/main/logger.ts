/**
 * Async file logger with batched writes, rotation, backpressure, and usage tracking.
 *
 * - Logs to {userData}/logs/fluidstate.log
 * - Batches writes — flushes every 200ms or when buffer exceeds 8KB (never blocks main thread)
 * - Backpressure: under load, drops INFO lines and widens flush interval
 * - Rotates to .old when file exceeds 2MB (only 2 files max on disk)
 * - Usage stats accumulated in {userData}/logs/usage.json (flushed every 30s)
 * - Console output preserved — devtools still works
 */

import { app } from 'electron'
import { join } from 'node:path'
import {
  mkdirSync, existsSync, statSync,
  readFileSync, writeFileSync, appendFileSync,
  rename, appendFile,
} from 'node:fs'

// ── Config ──

const MAX_LOG_SIZE = 2 * 1024 * 1024 // 2MB
const WRITE_INTERVAL_MIN = 250       // normal flush interval (ms) — relaxed for 9 agents
const WRITE_INTERVAL_MAX = 3000      // max flush interval under pressure
const WRITE_THRESHOLD = 16384        // 16KB — flush early (doubled for higher throughput)
const BUFFER_PRESSURE = 49152        // 48KB — above this, drop INFO lines
const USAGE_FLUSH_INTERVAL = 30_000  // flush usage.json every 30s

// Rate tracking — sliding 1-second window
const RATE_WINDOW = 1000             // 1s window
const RATE_LIMIT = 40                // max INFO lines/sec before sampling (tighter for 9 agents)
const RATE_SAMPLE = 5                // when rate-limited, log 1 in 5 (more aggressive sampling)

// ── State ──

let logDir: string | null = null
let logPath: string | null = null
let usagePath: string | null = null
let currentSize = 0
let initDone = false

// Hard cap on buffer — if writes can't keep up, shed oldest lines
const BUFFER_HARD_CAP = 131072  // 128KB — absolute max before truncation

// Write buffer — lines accumulate here, flushed async
let buffer = ''
let bufferBytes = 0
let writeTimer: ReturnType<typeof setTimeout> | null = null
let writing = false
let currentInterval = WRITE_INTERVAL_MIN

// Rate tracking
let rateWindowStart = 0
let rateCount = 0
let rateSampleCounter = 0
let droppedCount = 0

interface UsageRecord {
  totalInputTokens: number
  totalOutputTokens: number
  totalCostUsd: number
  totalSessions: number
  totalErrors: number
  lastUpdated: string
  /** Per-day summaries (last 7 days kept) */
  daily: Record<string, { input: number; output: number; cost: number; sessions: number; errors: number }>
}

let usage: UsageRecord | null = null
let usageDirty = false

// ── Init (sync, runs once) ──

function ensureInit(): void {
  if (initDone) return
  initDone = true
  try {
    logDir = join(app.getPath('userData'), 'logs')
    mkdirSync(logDir, { recursive: true })
    logPath = join(logDir, 'fluidstate.log')
    usagePath = join(logDir, 'usage.json')

    try {
      currentSize = statSync(logPath).size
    } catch {
      currentSize = 0
    }

    loadUsage()
  } catch {
    logPath = null
  }
}

// ── Usage persistence ──

function loadUsage(): void {
  if (!usagePath) return
  try {
    if (existsSync(usagePath)) {
      usage = JSON.parse(readFileSync(usagePath, 'utf-8'))
    }
  } catch { /* corrupt — reset */ }
  if (!usage) {
    usage = {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCostUsd: 0,
      totalSessions: 0,
      totalErrors: 0,
      lastUpdated: new Date().toISOString(),
      daily: {},
    }
  }
}

function flushUsageSync(): void {
  if (!usageDirty || !usagePath || !usage) return
  try {
    usage.lastUpdated = new Date().toISOString()
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - 7)
    const cutoffStr = cutoff.toISOString().slice(0, 10)
    for (const day of Object.keys(usage.daily)) {
      if (day < cutoffStr) delete usage.daily[day]
    }
    writeFileSync(usagePath, JSON.stringify(usage, null, 2))
    usageDirty = false
  } catch { /* best effort */ }
}

let usageTimer: ReturnType<typeof setInterval> | null = null

function ensureUsageTimer(): void {
  if (usageTimer) return
  usageTimer = setInterval(flushUsageSync, USAGE_FLUSH_INTERVAL)
  usageTimer.unref()
}

function ensureDay(): { input: number; output: number; cost: number; sessions: number; errors: number } {
  if (!usage) return { input: 0, output: 0, cost: 0, sessions: 0, errors: 0 }
  const day = new Date().toISOString().slice(0, 10)
  if (!usage.daily[day]) {
    usage.daily[day] = { input: 0, output: 0, cost: 0, sessions: 0, errors: 0 }
  }
  return usage.daily[day]
}

// ── Backpressure ──

/** Returns true if this INFO line should be dropped */
function shouldThrottleInfo(): boolean {
  const now = Date.now()

  // Reset window if expired
  if (now - rateWindowStart >= RATE_WINDOW) {
    // If we dropped lines in the last window, log a summary
    if (droppedCount > 0) {
      const summary = `${new Date().toISOString()} [INFO] [logger] throttled ${droppedCount} info lines (backpressure)\n`
      buffer += summary
      bufferBytes += Buffer.byteLength(summary)
      droppedCount = 0
    }
    rateWindowStart = now
    rateCount = 0
    rateSampleCounter = 0
  }

  rateCount++

  // Under rate limit — allow
  if (rateCount <= RATE_LIMIT) return false

  // Over rate limit — sample 1 in N
  rateSampleCounter++
  if (rateSampleCounter >= RATE_SAMPLE) {
    rateSampleCounter = 0
    return false // allow this one through
  }
  droppedCount++
  return true
}

/** Check if buffer is under too much pressure for INFO */
function isBufferPressure(): boolean {
  return bufferBytes >= BUFFER_PRESSURE
}

// ── Async batched write ──

function scheduleFlush(): void {
  if (writeTimer) return
  writeTimer = setTimeout(flushBuffer, currentInterval)
  writeTimer.unref()
}

function flushBuffer(): void {
  writeTimer = null
  if (!logPath || !buffer) return

  // Backpressure: if previous write still in flight, widen interval and retry later
  if (writing) {
    currentInterval = Math.min(currentInterval * 2, WRITE_INTERVAL_MAX)
    scheduleFlush()
    return
  }

  // Previous write finished — ease back toward normal interval
  if (currentInterval > WRITE_INTERVAL_MIN) {
    currentInterval = Math.max(WRITE_INTERVAL_MIN, Math.floor(currentInterval * 0.75))
  }

  const chunk = buffer
  const chunkBytes = bufferBytes
  buffer = ''
  bufferBytes = 0
  writing = true

  if (currentSize + chunkBytes > MAX_LOG_SIZE) {
    const oldPath = logPath + '.old'
    rename(logPath!, oldPath, () => {
      currentSize = 0
      doWrite(chunk, chunkBytes)
    })
  } else {
    doWrite(chunk, chunkBytes)
  }
}

function doWrite(chunk: string, chunkBytes: number): void {
  if (!logPath) { writing = false; return }
  appendFile(logPath, chunk, (err) => {
    writing = false
    if (!err) currentSize += chunkBytes
    if (buffer) scheduleFlush()
  })
}

function enqueue(line: string): void {
  const bytes = Buffer.byteLength(line)
  buffer += line
  bufferBytes += bytes

  // Hard cap: if buffer grows past 128KB, keep only the last 64KB
  if (bufferBytes >= BUFFER_HARD_CAP) {
    const half = BUFFER_HARD_CAP >> 1
    buffer = buffer.slice(-half)
    bufferBytes = Buffer.byteLength(buffer)
  }

  if (bufferBytes >= WRITE_THRESHOLD) {
    if (writeTimer) { clearTimeout(writeTimer); writeTimer = null }
    flushBuffer()
  } else {
    scheduleFlush()
  }
}

// ── Core ──

function writeLine(level: string, tag: string, message: string, extra?: string): void {
  ensureInit()

  // Backpressure for INFO: drop when system is busy
  if (level === 'INFO') {
    if (isBufferPressure() || shouldThrottleInfo()) return
  }

  // Console output
  const consoleMsg = `[${tag}] ${message}`
  if (level === 'ERROR') console.error(consoleMsg, extra || '')
  else if (level === 'WARN') console.warn(consoleMsg, extra || '')
  else console.log(consoleMsg, extra || '')

  if (!logPath) return

  const ts = new Date().toISOString()
  const line = extra
    ? `${ts} [${level}] [${tag}] ${message} ${extra}\n`
    : `${ts} [${level}] [${tag}] ${message}\n`

  enqueue(line)
}

// ── Public API ──

export const log = {
  info(tag: string, message: string, extra?: string): void {
    writeLine('INFO', tag, message, extra)
  },

  warn(tag: string, message: string, extra?: string): void {
    writeLine('WARN', tag, message, extra)
  },

  error(tag: string, message: string, error?: unknown): void {
    const extra = error instanceof Error
      ? `${error.message}\n${error.stack || ''}`
      : error ? String(error) : undefined
    writeLine('ERROR', tag, message, extra)
    ensureInit()
    if (usage) {
      const d = ensureDay()
      usage.totalErrors++
      d.errors++
      usageDirty = true
      ensureUsageTimer()
    }
  },

  /** Log token usage from a completed session */
  usage(tag: string, data: { inputTokens?: number; outputTokens?: number; costUsd?: number; model?: string }): void {
    ensureInit()
    if (!usage) return

    const inp = data.inputTokens || 0
    const out = data.outputTokens || 0
    const cost = data.costUsd || 0

    const d = ensureDay()
    usage.totalInputTokens += inp
    usage.totalOutputTokens += out
    usage.totalCostUsd += cost
    d.input += inp
    d.output += out
    d.cost += cost

    usageDirty = true
    ensureUsageTimer()

    writeLine('USAGE', tag, `in=${inp} out=${out} cost=$${cost.toFixed(4)}${data.model ? ` model=${data.model}` : ''}`)
  },

  /** Log a new session start */
  session(tag: string, agentId: string, provider: string): void {
    ensureInit()
    if (!usage) return

    const d = ensureDay()
    usage.totalSessions++
    d.sessions++
    usageDirty = true
    ensureUsageTimer()

    writeLine('INFO', tag, `session started agent=${agentId} provider=${provider}`)
  },

  /** Get current usage stats (for IPC/UI) */
  getUsage(): UsageRecord | null {
    ensureInit()
    return usage ? { ...usage } : null
  },

  /** Flush everything to disk synchronously (call on app quit) */
  flush(): void {
    if (writeTimer) { clearTimeout(writeTimer); writeTimer = null }
    if (logPath && buffer) {
      try {
        appendFileSync(logPath, buffer)
        buffer = ''
        bufferBytes = 0
      } catch { /* best effort */ }
    }
    flushUsageSync()
  },

  /** Get the log file path (for "open logs" feature) */
  getLogPath(): string | null {
    ensureInit()
    return logPath
  },
}
