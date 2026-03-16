import { ipcMain, dialog, clipboard, shell, app, BrowserWindow } from 'electron'
import { IPC } from '../shared/types'
import type { ProviderId } from '../shared/types'
import * as agent from './agent'
import * as auth from './auth'
import * as fs from './file-system'
import * as terminal from './terminal'
import { detectProviders } from './providers'
import { PROVIDER_CONFIGS } from '../shared/types'
import * as keystore from './keystore'
import { resolve, isAbsolute } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

// Saved bounds before pill mode
let savedBounds: Electron.Rectangle | null = null
let savedFullScreen = false

export function registerIpcHandlers() {
  // Auth
  ipcMain.handle(IPC.AUTH_STATUS, async () => {
    return auth.getAuthStatus()
  })

  ipcMain.handle(IPC.AUTH_LOGIN, async () => {
    return auth.login()
  })

  ipcMain.handle(IPC.AUTH_LOGOUT, async () => {
    return auth.logout()
  })

  // Dialog
  ipcMain.handle(IPC.DIALOG_OPEN_FOLDER, async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: 'Choose working directory for agent',
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  // Agent lifecycle
  ipcMain.handle(IPC.AGENT_CREATE, async (_, { name, cwd, provider }: { name: string; cwd: string; provider?: ProviderId }) => {
    return agent.createAgent(name, cwd, provider || 'claude')
  })

  ipcMain.handle(IPC.AGENT_CLOSE, async (_, { agentId }: { agentId: string }) => {
    terminal.closeAgentTerminal(agentId)
    return agent.closeAgent(agentId)
  })

  ipcMain.handle(IPC.AGENT_LIST, async () => {
    return agent.listAgents()
  })

  // Agent messaging — now with agentId
  ipcMain.handle(IPC.AGENT_SEND, async (_, { agentId, message }: { agentId: string; message: string }) => {
    console.log('[ipc] agent:send', agentId, message.slice(0, 60))
    const sessionId = await agent.sendPrompt(agentId, message)
    return { sessionId }
  })

  ipcMain.handle(IPC.AGENT_STOP, async (_, { agentId }: { agentId: string }) => {
    agent.stopSession(agentId)
  })

  ipcMain.handle(IPC.AGENT_PERMISSION_RESPOND, async (_, response) => {
    console.log(`[ipc] permission-respond agent=${response.agentId} req=${response.requestId} behavior=${response.behavior} hasUpdatedInput=${!!response.updatedInput} keys=${response.updatedInput ? Object.keys(response.updatedInput).join(',') : 'none'}`)
    agent.resolvePermission(response.agentId, response.requestId, response.behavior, response.updatedPermissions, response.updatedInput)
  })

  ipcMain.handle(IPC.AGENT_LIST_SESSIONS, async (_, { cwd }: { cwd?: string }) => {
    return agent.getSessions(cwd)
  })

  ipcMain.handle(IPC.AGENT_RESUME, async (_, { agentId, sessionId }: { agentId: string; sessionId: string }) => {
    console.log('[ipc] agent:resume', agentId, sessionId)
    await agent.resumeSession(agentId, sessionId)
  })

  ipcMain.handle(IPC.AGENT_CONTINUE, async (_, { agentId }: { agentId: string }) => {
    console.log('[ipc] agent:continue', agentId)
    await agent.continueSession(agentId)
  })

  ipcMain.handle(IPC.AGENT_RENAME, async (_, { agentId, name, sessionId, title }: { agentId?: string; name?: string; sessionId?: string; title?: string }) => {
    // Update in-memory agent name
    if (agentId && name) {
      agent.renameAgentName(agentId, name)
    }
    // Also rename the SDK session if provided
    if (sessionId && title) {
      await agent.doRenameSession(sessionId, title)
    }
  })

  ipcMain.handle(IPC.AGENT_SET_PERMISSION_MODE, async (_, { agentId, mode }: { agentId: string; mode: string }) => {
    return agent.setPermissionMode(agentId, mode)
  })

  ipcMain.handle(IPC.AGENT_GET_PERMISSION_MODE, async (_, { agentId }: { agentId: string }) => {
    return agent.getPermissionMode(agentId)
  })

  ipcMain.handle(IPC.AGENT_CLEAR_SESSION, async (_, { agentId }: { agentId: string }) => {
    agent.clearSession(agentId)
  })

  // Emit a system message back to renderer (so AgentCell's useAgent picks it up)
  ipcMain.handle(IPC.AGENT_EMIT_SYSTEM, async (event, { agentId, text }: { agentId: string; text: string }) => {
    event.sender.send(IPC.AGENT_MESSAGE, {
      agentId,
      id: Math.random().toString(36).slice(2, 10),
      type: 'system',
      text,
      ts: Date.now(),
    })
  })

  // CLI passthrough — runs `claude` CLI commands and returns stdout
  ipcMain.handle(IPC.CLI_RUN, async (_, { args, cwd }: { args: string[]; cwd?: string }) => {
    try {
      const claudePath = auth.getClaudePath()
      if (!claudePath) return { error: 'Claude CLI not found' }
      const { stdout, stderr } = await execFileAsync(claudePath, args, {
        cwd: cwd || process.cwd(),
        timeout: 30_000,
      })
      return { stdout, stderr }
    } catch (err: any) {
      return { error: err.message || String(err) }
    }
  })

  // Usage
  ipcMain.handle(IPC.USAGE_FETCH, async () => {
    return auth.fetchUsage()
  })

  // Model
  ipcMain.handle(IPC.AGENT_GET_MODEL, async (_, { agentId }: { agentId: string }) => {
    return agent.getModelInfo(agentId)
  })

  ipcMain.handle(IPC.AGENT_SET_MODEL, async (_, { agentId, model }: { agentId: string; model: string }) => {
    return agent.switchModel(agentId, model)
  })

  // File system
  ipcMain.handle(IPC.FS_READ_DIR, async (_, { path }: { path: string }) => {
    return fs.readDirectory(resolve(path))
  })

  ipcMain.handle(IPC.FS_READ_FILE, async (_, { path, cwd }: { path: string; cwd?: string }) => {
    const base = cwd || process.cwd()
    const absPath = isAbsolute(path) ? path : resolve(base, path)
    return fs.readFileContent(absPath)
  })

  ipcMain.handle(IPC.FS_WRITE_FILE, async (_, { path, content }: { path: string; content: string }) => {
    await fs.writeFileContent(resolve(path), content)
  })

  ipcMain.handle(IPC.FS_GIT_STATUS, async (_, { cwd }: { cwd: string }) => {
    return fs.getGitStatus(cwd)
  })

  ipcMain.handle(IPC.FS_GIT_DIFF, async (_, { path, cwd }: { path: string; cwd?: string }) => {
    const base = cwd || process.cwd()
    const absPath = isAbsolute(path) ? path : resolve(base, path)
    return fs.getGitDiff(absPath)
  })

  // SCM operations
  ipcMain.handle(IPC.FS_GIT_STATUS_DETAILED, async (_, { cwd }: { cwd: string }) => {
    return fs.getGitStatusDetailed(cwd)
  })

  ipcMain.handle(IPC.FS_GIT_STAGE, async (_, { path, cwd }: { path: string; cwd: string }) => {
    return fs.gitStage(path, cwd)
  })

  ipcMain.handle(IPC.FS_GIT_UNSTAGE, async (_, { path, cwd }: { path: string; cwd: string }) => {
    return fs.gitUnstage(path, cwd)
  })

  ipcMain.handle(IPC.FS_GIT_DISCARD, async (_, { path, cwd }: { path: string; cwd: string }) => {
    return fs.gitDiscard(path, cwd)
  })

  ipcMain.handle(IPC.FS_GIT_COMMIT, async (_, { message, cwd }: { message: string; cwd: string }) => {
    return fs.gitCommit(message, cwd)
  })

  // File search (for @ mentions)
  ipcMain.handle(IPC.FS_SEARCH_FILES, async (_, { cwd, query, limit }: { cwd: string; query: string; limit?: number }) => {
    return fs.searchFiles(cwd, query, limit)
  })

  // CLI install
  ipcMain.handle(IPC.CLI_INSTALL, async () => {
    const { installCLI } = await import('./cli-install')
    return installCLI()
  })

  ipcMain.handle(IPC.CLI_UNINSTALL, async () => {
    const { uninstallCLI } = await import('./cli-install')
    return uninstallCLI()
  })

  ipcMain.handle(IPC.CLI_IS_INSTALLED, async () => {
    const { isCLIInstalled } = await import('./cli-install')
    return isCLIInstalled()
  })

  // Terminal
  ipcMain.handle(IPC.TERM_CREATE, async (_, { agentId, cwd }: { agentId: string; cwd: string }) => {
    return terminal.getOrCreateTerminal(agentId, cwd)
  })

  ipcMain.handle(IPC.TERM_BUFFER, async (_, { terminalId }: { terminalId: string }) => {
    return { data: terminal.getBuffer(terminalId) }
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

  // Providers
  ipcMain.handle(IPC.PROVIDER_LIST, async () => {
    return PROVIDER_CONFIGS
  })

  ipcMain.handle(IPC.PROVIDER_DETECT, async () => {
    return detectProviders()
  })

  ipcMain.handle(IPC.PROVIDER_SET_API_KEY, async (_, { provider, key }: { provider: ProviderId; key: string }) => {
    keystore.setApiKey(provider, key)
  })

  ipcMain.handle(IPC.PROVIDER_GET_API_KEY, async (_, { provider }: { provider: ProviderId }) => {
    return keystore.hasApiKey(provider)
  })

  // Window pill mode — shrink window to floating pill
  ipcMain.handle(IPC.WINDOW_MINIMIZE_PILL, async (event, { agentCount }: { agentCount: number }) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return

    // Save current state
    savedFullScreen = win.isFullScreen()
    if (savedFullScreen) win.setFullScreen(false)
    savedBounds = win.getBounds()

    // Calculate pill size based on agent count
    const pillWidth = Math.max(320, Math.min(600, 140 * agentCount + 60))
    const pillHeight = 56

    // Position bottom-right of current screen
    const display = require('electron').screen.getDisplayMatching(savedBounds)
    const workArea = display.workArea
    const x = workArea.x + workArea.width - pillWidth - 20
    const y = workArea.y + workArea.height - pillHeight - 20

    win.setAlwaysOnTop(true, 'floating')
    win.setMinimumSize(200, 44)
    win.setBounds({ x, y, width: pillWidth, height: pillHeight }, true)
    // Hide traffic lights on macOS
    if (process.platform === 'darwin') {
      win.setWindowButtonVisibility(false)
    }
    win.setResizable(false)
  })

  ipcMain.handle(IPC.WINDOW_RESTORE_PILL, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return

    win.setAlwaysOnTop(false)
    win.setResizable(true)
    // Restore traffic lights on macOS
    if (process.platform === 'darwin') {
      win.setWindowButtonVisibility(true)
    }
    win.setMinimumSize(800, 600)
    if (savedBounds) {
      win.setBounds(savedBounds, true)
      savedBounds = null
    }
    if (savedFullScreen) {
      win.setFullScreen(true)
      savedFullScreen = false
    }
  })

  console.log('[ipc] all handlers registered')
}
