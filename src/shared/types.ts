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
  | { id: string; type: 'usage'; utilization: number; resetsAt: number | null; limitType: string; status: string; ts: number }
  | { id: string; type: 'token-usage'; inputTokens: number; outputTokens: number; ts: number }

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
  updatedInput?: Record<string, unknown>
}

// AskUserQuestion tool input shape (from Claude Agent SDK)
interface AskUserQuestionOption {
  label: string
  description: string
  markdown?: string
}

interface AskUserQuestionItem {
  question: string
  header: string
  options: AskUserQuestionOption[]
  multiSelect: boolean
}

export interface AskUserQuestionInput {
  questions: AskUserQuestionItem[]
}

export interface SessionInfo {
  sessionId: string
  summary: string
  lastModified: number
  cwd?: string
}

// Multi-agent descriptor
export interface AgentDescriptor {
  id: string
  name: string
  cwd: string
  isActive: boolean
  provider: ProviderId
  codexStatus?: CodexStatus
}

// Slash command definition
export interface SlashCommand {
  command: string
  description: string
  category: 'session' | 'agent' | 'view' | 'config' | 'history' | 'info' | 'misc'
  aliases?: string[]
}

// Keyboard shortcut definition
export interface KeyboardShortcut {
  keys: string
  description: string
  category: 'navigation' | 'agent' | 'view'
}

// AI journey phases
export type AgentPhase =
  | 'idle'
  | 'thinking'
  | 'researching'
  | 'searching'
  | 'planning'
  | 'coding'
  | 'testing'
  | 'debugging'
  | 'reviewing'
  | 'done'
  | 'stuck'
  | 'awaiting'

export interface PhaseInfo {
  phase: AgentPhase
  label: string
  detail: string // e.g. "Reading package.json..."
  color: string
  startedAt: number
  activeTool?: ActiveToolInfo
}

// Codex indexing status
export type CodexStatusState = 'loading' | 'indexing' | 'ready' | 'error'

export interface CodexStatus {
  state: CodexStatusState
  filesProcessed?: number
  totalFiles?: number
  symbols?: number
  error?: string
}

// Active tool tracking (for progress display)
export interface ActiveToolInfo {
  toolUseId: string
  toolName: string
  startTs: number
  elapsed: number
}

// File activity tracking
export type FileOperationType = 'read' | 'write' | 'create' | 'execute'

export interface FileOperation {
  type: FileOperationType
  toolUseId: string
  toolName: string
  timestamp: number
  agentId?: string
  agentName?: string
  // Edit tool: old_string / new_string for diff display
  editOldString?: string
  editNewString?: string
  // Write tool: full content written
  writeContent?: string
}

export interface TrackedFile {
  path: string
  basename: string
  operations: FileOperation[]
  firstSeen: number
  lastSeen: number
}

// Auth status from `claude auth status`
export interface AuthStatus {
  authenticated: boolean
  email?: string
  organization?: string
  error?: string
}

// Provider identifiers
export type ProviderId = 'claude' | 'copilot' | 'openai' | 'gemini'

// Provider config — describes capabilities and display info
export interface ProviderConfig {
  id: ProviderId
  displayName: string
  shortLabel: string
  color: string
  authType: 'cli-login' | 'api-key' | 'oauth'
  supportsResume: boolean
  supportsPermissions: boolean
  supportsModelSwitch: boolean
}

export const PROVIDER_CONFIGS: Record<ProviderId, ProviderConfig> = {
  claude: {
    id: 'claude',
    displayName: 'Claude',
    shortLabel: 'CLAUDE',
    color: '#D97706',
    authType: 'cli-login',
    supportsResume: true,
    supportsPermissions: true,
    supportsModelSwitch: true,
  },
  copilot: {
    id: 'copilot',
    displayName: 'GitHub Copilot',
    shortLabel: 'COPILOT',
    color: '#2EA043',
    authType: 'oauth',
    supportsResume: false,
    supportsPermissions: false,
    supportsModelSwitch: false,
  },
  openai: {
    id: 'openai',
    displayName: 'OpenAI Codex',
    shortLabel: 'OPENAI',
    color: '#10A37F',
    authType: 'api-key',
    supportsResume: false,
    supportsPermissions: false,
    supportsModelSwitch: true,
  },
  gemini: {
    id: 'gemini',
    displayName: 'Google Gemini',
    shortLabel: 'GEMINI',
    color: '#4285F4',
    authType: 'api-key',
    supportsResume: false,
    supportsPermissions: false,
    supportsModelSwitch: true,
  },
}

// Permission modes (mirrors SDK PermissionMode)
export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions' | 'dontAsk'

export const PERMISSION_MODE_LABELS: Record<PermissionMode, string> = {
  default: 'Default',
  acceptEdits: 'Accept Edits',
  plan: 'Plan Mode',
  bypassPermissions: 'Bypass All',
  dontAsk: "Don't Ask",
}

// Git file status (detailed — separates staged/unstaged/untracked)
export interface GitFileStatus {
  path: string
  basename: string
  indexStatus: string    // X column from porcelain: ' '|'M'|'A'|'D'|'R'|'?'
  workTreeStatus: string // Y column: ' '|'M'|'D'|'?'
  category: 'staged' | 'unstaged' | 'untracked'
}

// IPC channel names
export const IPC = {
  // Auth
  AUTH_LOGIN: 'auth:login',
  AUTH_LOGOUT: 'auth:logout',
  AUTH_STATUS: 'auth:status',
  // Agent
  AGENT_START: 'agent:start',
  AGENT_SEND: 'agent:send',
  AGENT_STOP: 'agent:stop',
  AGENT_PERMISSION_RESPOND: 'agent:permission-respond',
  AGENT_LIST_SESSIONS: 'agent:list-sessions',
  AGENT_RESUME: 'agent:resume',
  AGENT_CONTINUE: 'agent:continue',
  AGENT_CREATE: 'agent:create',
  AGENT_CLOSE: 'agent:close',
  AGENT_LIST: 'agent:list',
  AGENT_RENAME: 'agent:rename',
  AGENT_SET_PERMISSION_MODE: 'agent:set-permission-mode',
  AGENT_GET_PERMISSION_MODE: 'agent:get-permission-mode',
  AGENT_CLEAR_SESSION: 'agent:clear-session',
  // CLI passthrough (runs `claude` CLI commands)
  CLI_RUN: 'cli:run',
  // Emit a local system message (renderer -> main -> renderer broadcast)
  AGENT_EMIT_SYSTEM: 'agent:emit-system',
  // Agent events (main -> renderer)
  AGENT_MESSAGE: 'agent:message',
  AGENT_MESSAGE_BATCH: 'agent:message-batch',
  AGENT_PERMISSION_REQUEST: 'agent:permission-request',
  AGENT_PERMISSION_DISMISSED: 'agent:permission-dismissed',
  AGENT_SESSION_STARTED: 'agent:session-started',
  AGENT_SESSION_ENDED: 'agent:session-ended',
  // Dialog
  DIALOG_OPEN_FOLDER: 'dialog:open-folder',
  // File system
  FS_READ_DIR: 'fs:read-dir',
  FS_READ_FILE: 'fs:read-file',
  FS_WRITE_FILE: 'fs:write-file',
  FS_GIT_DIFF: 'fs:git-diff',
  FS_GIT_STATUS: 'fs:git-status',
  FS_GIT_STATUS_DETAILED: 'fs:git-status-detailed',
  FS_GIT_STAGE: 'fs:git-stage',
  FS_GIT_UNSTAGE: 'fs:git-unstage',
  FS_GIT_DISCARD: 'fs:git-discard',
  FS_GIT_COMMIT: 'fs:git-commit',
  // CLI install
  CLI_INSTALL: 'cli:install',
  CLI_UNINSTALL: 'cli:uninstall',
  CLI_IS_INSTALLED: 'cli:is-installed',
  // App
  APP_INITIAL_CWD: 'app:initial-cwd',
  // Terminal
  TERM_CREATE: 'term:create',
  TERM_CREATE_CLAUDE: 'term:create-claude',
  TERM_CREATE_CODEX: 'term:create-codex',
  TERM_WRITE_AGENT: 'term:write-agent',
  TERM_BUFFER: 'term:buffer',
  TERM_WRITE: 'term:write',
  TERM_RESIZE: 'term:resize',
  TERM_CLOSE: 'term:close',
  TERM_DATA: 'term:data',
  TERM_EXIT: 'term:exit',
  // Usage & Model
  USAGE_FETCH: 'usage:fetch',
  AGENT_GET_MODEL: 'agent:get-model',
  AGENT_SET_MODEL: 'agent:set-model',
  // File search (for @ mentions)
  FS_SEARCH_FILES: 'fs:search-files',
  // Providers
  PROVIDER_LIST: 'provider:list',
  PROVIDER_DETECT: 'provider:detect',
  PROVIDER_SET_API_KEY: 'provider:set-api-key',
  PROVIDER_GET_API_KEY: 'provider:get-api-key',
  // Window pill mode
  WINDOW_MINIMIZE_PILL: 'window:minimize-pill',
  WINDOW_RESTORE_PILL: 'window:restore-pill',
  // Auto-update
  UPDATE_CHECK: 'update:check',
  UPDATE_DOWNLOAD: 'update:download',
  UPDATE_INSTALL: 'update:install',
  UPDATE_STATUS: 'update:status',
  // Logging
  LOG_GET_USAGE: 'log:get-usage',
  LOG_GET_PATH: 'log:get-path',
  // Codex status (main -> renderer)
  CODEX_STATUS: 'codex:status',
  // Resource stats (observability)
  RESOURCE_STATS: 'resource:stats',
} as const

export interface ResourceStats {
  memoryMB: number
  heapUsedMB: number
  heapTotalMB: number
  externalMB: number
  agentCount: number
  activeAgentCount: number
  codexReadyCount: number
  uptimeSeconds: number
}

export type UpdateStatus =
  | { state: 'checking' }
  | { state: 'available'; version: string; releaseNotes?: string }
  | { state: 'not-available'; currentVersion: string }
  | { state: 'downloading'; percent: number }
  | { state: 'downloaded'; version: string }
  | { state: 'error'; message: string }
