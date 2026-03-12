// IPC channel contract between main and renderer

export interface FileEntry {
  name: string
  path: string
  type: 'file' | 'directory'
  children?: FileEntry[]
}

// Simplified UI message model
export type UIMessage =
  | { id: string; type: 'user'; text: string; ts: number }
  | { id: string; type: 'assistant'; text: string; isStreaming: boolean; ts: number }
  | { id: string; type: 'tool-use'; toolName: string; toolUseId: string; input: unknown; ts: number }
  | { id: string; type: 'tool-result'; toolUseId: string; output: string; ts: number }
  | { id: string; type: 'tool-progress'; toolName: string; toolUseId: string; elapsed: number; ts: number }
  | { id: string; type: 'result'; cost: number; duration: number; numTurns: number; ts: number }
  | { id: string; type: 'error'; message: string; ts: number }
  | { id: string; type: 'system'; text: string; ts: number }

export interface PermissionRequest {
  requestId: string
  toolName: string
  input: Record<string, unknown>
  decisionReason?: string
  suggestions?: unknown[]
}

export interface PermissionResponse {
  requestId: string
  behavior: 'allow' | 'deny'
  updatedPermissions?: unknown[]
}

export interface SessionInfo {
  sessionId: string
  summary: string
  lastModified: number
  cwd?: string
}

// IPC channel names
export const IPC = {
  // Agent
  AGENT_START: 'agent:start',
  AGENT_SEND: 'agent:send',
  AGENT_STOP: 'agent:stop',
  AGENT_PERMISSION_RESPOND: 'agent:permission-respond',
  AGENT_LIST_SESSIONS: 'agent:list-sessions',
  AGENT_RESUME: 'agent:resume',
  // Agent events (main -> renderer)
  AGENT_MESSAGE: 'agent:message',
  AGENT_PERMISSION_REQUEST: 'agent:permission-request',
  AGENT_SESSION_STARTED: 'agent:session-started',
  AGENT_SESSION_ENDED: 'agent:session-ended',
  // File system
  FS_READ_DIR: 'fs:read-dir',
  FS_READ_FILE: 'fs:read-file',
  FS_WRITE_FILE: 'fs:write-file',
  // Terminal
  TERM_CREATE: 'term:create',
  TERM_WRITE: 'term:write',
  TERM_RESIZE: 'term:resize',
  TERM_CLOSE: 'term:close',
  TERM_DATA: 'term:data',
  TERM_EXIT: 'term:exit',
} as const
