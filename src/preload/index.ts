import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/types'
import type { PermissionResponse, ProviderId, ProviderConfig } from '../shared/types'

const api = {
  // Auth
  authStatus: () => ipcRenderer.invoke(IPC.AUTH_STATUS),
  authLogin: () => ipcRenderer.invoke(IPC.AUTH_LOGIN),
  authLogout: () => ipcRenderer.invoke(IPC.AUTH_LOGOUT),

  // Dialog
  openFolderDialog: (): Promise<string | null> =>
    ipcRenderer.invoke(IPC.DIALOG_OPEN_FOLDER),

  // Agent lifecycle
  createAgent: (name: string, cwd: string, provider?: ProviderId) =>
    ipcRenderer.invoke(IPC.AGENT_CREATE, { name, cwd, provider }),
  closeAgent: (agentId: string) =>
    ipcRenderer.invoke(IPC.AGENT_CLOSE, { agentId }),
  listAgents: () =>
    ipcRenderer.invoke(IPC.AGENT_LIST),

  // Agent messaging — all take agentId
  sendMessage: (agentId: string, message: string) =>
    ipcRenderer.invoke(IPC.AGENT_SEND, { agentId, message }),
  stopAgent: (agentId: string) =>
    ipcRenderer.invoke(IPC.AGENT_STOP, { agentId }),
  respondPermission: (agentId: string, response: PermissionResponse) =>
    ipcRenderer.invoke(IPC.AGENT_PERMISSION_RESPOND, { agentId, requestId: response.requestId, behavior: response.behavior, updatedPermissions: response.updatedPermissions, updatedInput: response.updatedInput }),
  listSessions: (agentId: string, cwd?: string) =>
    ipcRenderer.invoke(IPC.AGENT_LIST_SESSIONS, { agentId, cwd }),
  resumeSession: (agentId: string, sessionId: string) =>
    ipcRenderer.invoke(IPC.AGENT_RESUME, { agentId, sessionId }),
  continueSession: (agentId: string) =>
    ipcRenderer.invoke(IPC.AGENT_CONTINUE, { agentId }),
  renameAgent: (agentId: string, name: string) =>
    ipcRenderer.invoke(IPC.AGENT_RENAME, { agentId, name }),
  renameSession: (sessionId: string, title: string) =>
    ipcRenderer.invoke(IPC.AGENT_RENAME, { sessionId, title }),
  cliRun: (args: string[], cwd?: string): Promise<{ stdout?: string; stderr?: string; error?: string }> =>
    ipcRenderer.invoke(IPC.CLI_RUN, { args, cwd }),
  /** Emit a system message that goes through IPC so all useAgent listeners see it */
  emitSystemMessage: (agentId: string, text: string) =>
    ipcRenderer.invoke(IPC.AGENT_EMIT_SYSTEM, { agentId, text }),
  setPermissionMode: (agentId: string, mode: string): Promise<string> =>
    ipcRenderer.invoke(IPC.AGENT_SET_PERMISSION_MODE, { agentId, mode }),
  getPermissionMode: (agentId: string): Promise<string> =>
    ipcRenderer.invoke(IPC.AGENT_GET_PERMISSION_MODE, { agentId }),
  clearSession: (agentId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.AGENT_CLEAR_SESSION, { agentId }),

  // Usage
  fetchUsage: (): Promise<Record<string, unknown>> =>
    ipcRenderer.invoke(IPC.USAGE_FETCH),

  // Model
  getModelInfo: (agentId: string): Promise<{ current: string; models: { value: string; displayName: string; description: string }[] }> =>
    ipcRenderer.invoke(IPC.AGENT_GET_MODEL, { agentId }),
  setModel: (agentId: string, model: string): Promise<void> =>
    ipcRenderer.invoke(IPC.AGENT_SET_MODEL, { agentId, model }),

  // File system
  readDir: (path: string) =>
    ipcRenderer.invoke(IPC.FS_READ_DIR, { path }),
  readFile: (path: string, cwd?: string) =>
    ipcRenderer.invoke(IPC.FS_READ_FILE, { path, cwd }),
  writeFile: (path: string, content: string) =>
    ipcRenderer.invoke(IPC.FS_WRITE_FILE, { path, content }),
  gitDiff: (path: string, cwd?: string) =>
    ipcRenderer.invoke(IPC.FS_GIT_DIFF, { path, cwd }),
  gitStatus: (cwd: string): Promise<{ files: { path: string; status: string }[] }> =>
    ipcRenderer.invoke(IPC.FS_GIT_STATUS, { cwd }),
  gitStatusDetailed: (cwd: string) =>
    ipcRenderer.invoke(IPC.FS_GIT_STATUS_DETAILED, { cwd }),
  gitStage: (path: string, cwd: string) =>
    ipcRenderer.invoke(IPC.FS_GIT_STAGE, { path, cwd }),
  gitUnstage: (path: string, cwd: string) =>
    ipcRenderer.invoke(IPC.FS_GIT_UNSTAGE, { path, cwd }),
  gitDiscard: (path: string, cwd: string) =>
    ipcRenderer.invoke(IPC.FS_GIT_DISCARD, { path, cwd }),
  gitCommit: (message: string, cwd: string) =>
    ipcRenderer.invoke(IPC.FS_GIT_COMMIT, { message, cwd }),
  // File search (for @ mentions)
  searchFiles: (cwd: string, query: string, limit?: number): Promise<string[]> =>
    ipcRenderer.invoke(IPC.FS_SEARCH_FILES, { cwd, query, limit }),

  // CLI install
  installCLI: () => ipcRenderer.invoke(IPC.CLI_INSTALL),
  uninstallCLI: () => ipcRenderer.invoke(IPC.CLI_UNINSTALL),
  isCLIInstalled: () => ipcRenderer.invoke(IPC.CLI_IS_INSTALLED),

  // Terminal
  createTerminal: (agentId: string, cwd: string): Promise<{ terminalId: string; isNew: boolean }> =>
    ipcRenderer.invoke(IPC.TERM_CREATE, { agentId, cwd }),
  createClaudeTerminal: (agentId: string, cwd: string, resume?: string): Promise<{ terminalId: string; isNew: boolean }> =>
    ipcRenderer.invoke(IPC.TERM_CREATE_CLAUDE, { agentId, cwd, resume }),
  createCodexTerminal: (agentId: string, cwd: string): Promise<{ terminalId: string; isNew: boolean }> =>
    ipcRenderer.invoke(IPC.TERM_CREATE_CODEX, { agentId, cwd }),
  getTerminalBuffer: (terminalId: string): Promise<{ data: string }> =>
    ipcRenderer.invoke(IPC.TERM_BUFFER, { terminalId }),
  writeTerminal: (terminalId: string, data: string) =>
    ipcRenderer.invoke(IPC.TERM_WRITE, { terminalId, data }),
  resizeTerminal: (terminalId: string, cols: number, rows: number) =>
    ipcRenderer.invoke(IPC.TERM_RESIZE, { terminalId, cols, rows }),
  closeTerminal: (terminalId: string) =>
    ipcRenderer.invoke(IPC.TERM_CLOSE, { terminalId }),
  writeToAgentTerminal: (agentId: string, data: string) =>
    ipcRenderer.invoke(IPC.TERM_WRITE_AGENT, { agentId, data }),

  // Providers
  listProviders: (): Promise<Record<ProviderId, ProviderConfig>> =>
    ipcRenderer.invoke(IPC.PROVIDER_LIST),
  detectProviders: (): Promise<Record<ProviderId, { available: boolean; error?: string }>> =>
    ipcRenderer.invoke(IPC.PROVIDER_DETECT),
  setProviderApiKey: (provider: ProviderId, key: string): Promise<void> =>
    ipcRenderer.invoke(IPC.PROVIDER_SET_API_KEY, { provider, key }),
  hasProviderApiKey: (provider: ProviderId): Promise<boolean> =>
    ipcRenderer.invoke(IPC.PROVIDER_GET_API_KEY, { provider }),

  // Window pill mode
  minimizeToPill: (agentCount: number) =>
    ipcRenderer.invoke(IPC.WINDOW_MINIMIZE_PILL, { agentCount }),
  restoreFromPill: () =>
    ipcRenderer.invoke(IPC.WINDOW_RESTORE_PILL),

  // Logging
  getLogUsage: (): Promise<any> => ipcRenderer.invoke(IPC.LOG_GET_USAGE),
  getLogPath: (): Promise<string | null> => ipcRenderer.invoke(IPC.LOG_GET_PATH),

  // Auto-update
  checkForUpdates: () => ipcRenderer.invoke(IPC.UPDATE_CHECK),
  downloadUpdate: () => ipcRenderer.invoke(IPC.UPDATE_DOWNLOAD),
  installUpdate: () => ipcRenderer.invoke(IPC.UPDATE_INSTALL),
  setGitHubToken: (token: string) => ipcRenderer.invoke(IPC.UPDATE_SET_GH_TOKEN, token),
  hasGitHubToken: (): Promise<boolean> => ipcRenderer.invoke(IPC.UPDATE_HAS_GH_TOKEN),
  removeGitHubToken: () => ipcRenderer.invoke(IPC.UPDATE_REMOVE_GH_TOKEN),
  onUpdateStatus: (cb: (data: any) => void) => {
    const handler = (_: any, data: any) => cb(data)
    ipcRenderer.on(IPC.UPDATE_STATUS, handler)
    return () => ipcRenderer.removeListener(IPC.UPDATE_STATUS, handler)
  },

  // Events — all agent events now include { agentId, ...payload }
  onAgentMessage: (cb: (data: any) => void) => {
    const handler = (_: any, data: any) => cb(data)
    ipcRenderer.on(IPC.AGENT_MESSAGE, handler)
    return () => {
      ipcRenderer.removeListener(IPC.AGENT_MESSAGE, handler)
    }
  },
  onAgentMessageBatch: (cb: (data: { agentId: string; messages: any[] }) => void) => {
    const handler = (_: any, data: { agentId: string; messages: any[] }) => cb(data)
    ipcRenderer.on(IPC.AGENT_MESSAGE_BATCH, handler)
    return () => ipcRenderer.removeListener(IPC.AGENT_MESSAGE_BATCH, handler)
  },
  onPermissionRequest: (cb: (data: any) => void) => {
    const handler = (_: any, data: any) => cb(data)
    ipcRenderer.on(IPC.AGENT_PERMISSION_REQUEST, handler)
    return () => ipcRenderer.removeListener(IPC.AGENT_PERMISSION_REQUEST, handler)
  },
  onPermissionDismissed: (cb: (data: { agentId: string; requestId: string }) => void) => {
    const handler = (_: any, data: any) => cb(data)
    ipcRenderer.on(IPC.AGENT_PERMISSION_DISMISSED, handler)
    return () => ipcRenderer.removeListener(IPC.AGENT_PERMISSION_DISMISSED, handler)
  },
  onSessionStarted: (cb: (data: any) => void) => {
    const handler = (_: any, data: any) => cb(data)
    ipcRenderer.on(IPC.AGENT_SESSION_STARTED, handler)
    return () => ipcRenderer.removeListener(IPC.AGENT_SESSION_STARTED, handler)
  },
  onSessionEnded: (cb: (data: any) => void) => {
    const handler = (_: any, data: any) => cb(data)
    ipcRenderer.on(IPC.AGENT_SESSION_ENDED, handler)
    return () => ipcRenderer.removeListener(IPC.AGENT_SESSION_ENDED, handler)
  },
  onTerminalData: (cb: (data: { terminalId: string; data: string }) => void) => {
    const handler = (_: any, data: any) => cb(data)
    ipcRenderer.on(IPC.TERM_DATA, handler)
    return () => ipcRenderer.removeListener(IPC.TERM_DATA, handler)
  },
  onTerminalExit: (cb: (data: { terminalId: string; code: number }) => void) => {
    const handler = (_: any, data: any) => cb(data)
    ipcRenderer.on(IPC.TERM_EXIT, handler)
    return () => ipcRenderer.removeListener(IPC.TERM_EXIT, handler)
  },
  onInitialCwd: (cb: (cwd: string) => void) => {
    const handler = (_: any, cwd: string) => cb(cwd)
    ipcRenderer.on(IPC.APP_INITIAL_CWD, handler)
    return () => ipcRenderer.removeListener(IPC.APP_INITIAL_CWD, handler)
  },

  // Resource stats
  getResourceStats: () => ipcRenderer.invoke(IPC.RESOURCE_STATS),
  onResourceStats: (cb: (data: any) => void) => {
    const handler = (_: any, data: any) => cb(data)
    ipcRenderer.on(IPC.RESOURCE_STATS, handler)
    return () => ipcRenderer.removeListener(IPC.RESOURCE_STATS, handler)
  },

  // Codex status (indexing progress)
  onCodexStatus: (cb: (data: any) => void) => {
    const handler = (_: any, data: any) => cb(data)
    ipcRenderer.on(IPC.CODEX_STATUS, handler)
    return () => ipcRenderer.removeListener(IPC.CODEX_STATUS, handler)
  },
}

contextBridge.exposeInMainWorld('api', api)

export type API = typeof api
