import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/types'
import type { PermissionResponse } from '../shared/types'

const api = {
  // Agent — just send a message, session auto-starts
  sendMessage: (message: string) =>
    ipcRenderer.invoke(IPC.AGENT_SEND, { message }),
  stopAgent: () =>
    ipcRenderer.invoke(IPC.AGENT_STOP),
  respondPermission: (response: PermissionResponse) =>
    ipcRenderer.invoke(IPC.AGENT_PERMISSION_RESPOND, response),
  listSessions: (cwd?: string) =>
    ipcRenderer.invoke(IPC.AGENT_LIST_SESSIONS, { cwd }),

  // File system
  readDir: (path: string) =>
    ipcRenderer.invoke(IPC.FS_READ_DIR, { path }),
  readFile: (path: string) =>
    ipcRenderer.invoke(IPC.FS_READ_FILE, { path }),
  writeFile: (path: string, content: string) =>
    ipcRenderer.invoke(IPC.FS_WRITE_FILE, { path, content }),

  // Terminal
  createTerminal: (cwd: string) =>
    ipcRenderer.invoke(IPC.TERM_CREATE, { cwd }),
  writeTerminal: (terminalId: string, data: string) =>
    ipcRenderer.invoke(IPC.TERM_WRITE, { terminalId, data }),
  resizeTerminal: (terminalId: string, cols: number, rows: number) =>
    ipcRenderer.invoke(IPC.TERM_RESIZE, { terminalId, cols, rows }),
  closeTerminal: (terminalId: string) =>
    ipcRenderer.invoke(IPC.TERM_CLOSE, { terminalId }),

  // Events
  onAgentMessage: (cb: (msg: any) => void) => {
    const handler = (_: any, msg: any) => cb(msg)
    ipcRenderer.on(IPC.AGENT_MESSAGE, handler)
    return () => ipcRenderer.removeListener(IPC.AGENT_MESSAGE, handler)
  },
  onPermissionRequest: (cb: (req: any) => void) => {
    const handler = (_: any, req: any) => cb(req)
    ipcRenderer.on(IPC.AGENT_PERMISSION_REQUEST, handler)
    return () => ipcRenderer.removeListener(IPC.AGENT_PERMISSION_REQUEST, handler)
  },
  onSessionStarted: (cb: (info: any) => void) => {
    const handler = (_: any, info: any) => cb(info)
    ipcRenderer.on(IPC.AGENT_SESSION_STARTED, handler)
    return () => ipcRenderer.removeListener(IPC.AGENT_SESSION_STARTED, handler)
  },
  onSessionEnded: (cb: (info: any) => void) => {
    const handler = (_: any, info: any) => cb(info)
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
}

contextBridge.exposeInMainWorld('api', api)

export type API = typeof api
