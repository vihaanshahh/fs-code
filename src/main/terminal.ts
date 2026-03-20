import * as pty from 'node-pty'
import type { IPty } from 'node-pty'
import type { BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { IPC } from '../shared/types'

interface TerminalEntry {
  id: string
  proc: IPty
  buffer: string
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

  const entry: TerminalEntry = { id, proc, buffer: '' }
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

/** Get buffered output for a terminal (for replaying on reattach). */
export function getBuffer(terminalId: string): string {
  return terminals.get(terminalId)?.buffer || ''
}

export function writeToTerminal(terminalId: string, data: string) {
  const entry = terminals.get(terminalId)
  entry?.proc.write(data)
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
    entry.proc.kill()
  }
  terminals.clear()
  agentTerminals.clear()
}
