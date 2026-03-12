import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import type { BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { IPC } from '../shared/types'

const terminals = new Map<string, ChildProcess>()
let mainWindow: BrowserWindow | null = null

export function setMainWindow(win: BrowserWindow) {
  mainWindow = win
}

export function createTerminal(cwd: string): string {
  const id = randomUUID().slice(0, 8)
  const shell = process.env.SHELL || '/bin/bash'

  const proc = spawn(shell, ['-l'], {
    cwd,
    env: { ...process.env, TERM: 'xterm-256color' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  terminals.set(id, proc)

  proc.stdout?.on('data', (data: Buffer) => {
    mainWindow?.webContents.send(IPC.TERM_DATA, { terminalId: id, data: data.toString() })
  })

  proc.stderr?.on('data', (data: Buffer) => {
    mainWindow?.webContents.send(IPC.TERM_DATA, { terminalId: id, data: data.toString() })
  })

  proc.on('exit', (code) => {
    terminals.delete(id)
    mainWindow?.webContents.send(IPC.TERM_EXIT, { terminalId: id, code: code || 0 })
  })

  return id
}

export function writeToTerminal(terminalId: string, data: string) {
  const proc = terminals.get(terminalId)
  proc?.stdin?.write(data)
}

export function resizeTerminal(_terminalId: string, _cols: number, _rows: number) {
  // Without node-pty, resize is limited. Users can install node-pty for proper PTY support.
}

export function closeTerminal(terminalId: string) {
  const proc = terminals.get(terminalId)
  if (proc) {
    proc.kill()
    terminals.delete(terminalId)
  }
}

export function closeAll() {
  for (const [id, proc] of terminals) {
    proc.kill()
  }
  terminals.clear()
}
