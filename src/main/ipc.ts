import { ipcMain } from 'electron'
import { IPC } from '../shared/types'
import * as agent from './agent'
import * as fs from './file-system'
import * as terminal from './terminal'
import { resolve } from 'node:path'

export function registerIpcHandlers() {
  // Agent
  ipcMain.handle(IPC.AGENT_START, async (_, { cwd, model }: { cwd: string; model?: string }) => {
    const sessionId = await agent.startSession(cwd, model)
    return { sessionId }
  })

  ipcMain.handle(IPC.AGENT_SEND, async (_, { message }: { message: string }) => {
    await agent.sendMessage(message)
  })

  ipcMain.handle(IPC.AGENT_STOP, async () => {
    agent.stopSession()
  })

  ipcMain.handle(IPC.AGENT_PERMISSION_RESPOND, async (_, response) => {
    agent.resolvePermission(
      response.requestId,
      response.behavior,
      response.updatedPermissions
    )
  })

  ipcMain.handle(IPC.AGENT_LIST_SESSIONS, async (_, { cwd }: { cwd?: string }) => {
    return agent.getSessions(cwd)
  })

  ipcMain.handle(IPC.AGENT_RESUME, async (_, { sessionId }: { sessionId: string }) => {
    // TODO: implement resume via unstable_v2_resumeSession
    throw new Error('Resume not yet implemented')
  })

  // File system
  ipcMain.handle(IPC.FS_READ_DIR, async (_, { path }: { path: string }) => {
    return fs.readDirectory(resolve(path))
  })

  ipcMain.handle(IPC.FS_READ_FILE, async (_, { path }: { path: string }) => {
    return fs.readFileContent(resolve(path))
  })

  ipcMain.handle(IPC.FS_WRITE_FILE, async (_, { path, content }: { path: string; content: string }) => {
    await fs.writeFileContent(resolve(path), content)
  })

  // Terminal
  ipcMain.handle(IPC.TERM_CREATE, async (_, { cwd }: { cwd: string }) => {
    const terminalId = terminal.createTerminal(cwd)
    return { terminalId }
  })

  ipcMain.handle(IPC.TERM_WRITE, async (_, { terminalId, data }: { terminalId: string; data: string }) => {
    terminal.writeToTerminal(terminalId, data)
  })

  ipcMain.handle(IPC.TERM_RESIZE, async (_, { terminalId, cols, rows }: { terminalId: string; cols: number; rows: number }) => {
    terminal.resizeTerminal(terminalId, cols, rows)
  })

  ipcMain.handle(IPC.TERM_CLOSE, async (_, { terminalId }: { terminalId: string }) => {
    terminal.closeTerminal(terminalId)
  })
}
