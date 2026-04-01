/**
 * Tauri API shim — maps every window.api method to Tauri invoke/listen.
 *
 * This file is only bundled when VITE_TAURI=true. It has no runtime effect
 * in the Electron build. In Phase 1, replace the _invoke/_listen stubs below
 * with real imports from @tauri-apps/api/core and @tauri-apps/api/event.
 *
 * Naming convention for Tauri commands: snake_case matching the Rust handler.
 * Naming convention for Tauri events: "agent://message", "term://data", etc.
 */

import type { API } from '../../preload/index'
import type { PermissionResponse, ProviderId } from '../../shared/types'

// ---------------------------------------------------------------------------
// Tauri runtime bridging — invoke for request/response, listen for events.
// listen() returns an unlisten function matching the Electron pattern.
// ---------------------------------------------------------------------------
import { invoke as tauriInvoke } from '@tauri-apps/api/core'
import { listen as tauriListen } from '@tauri-apps/api/event'

function _invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return tauriInvoke<T>(cmd, args)
}

function _listen<T>(event: string, cb: (payload: T) => void): () => void {
  // tauriListen returns Promise<UnlistenFn> — we return a sync cleanup stub
  // that resolves the promise and calls unlisten. React effects can call the
  // returned function synchronously; the actual unlisten completes async.
  let unlisten: (() => void) | null = null
  let cancelled = false
  tauriListen<T>(event, (e) => cb(e.payload)).then((fn) => {
    if (cancelled) fn()
    else unlisten = fn
  })
  return () => {
    cancelled = true
    unlisten?.()
  }
}

// ---------------------------------------------------------------------------
// Shim — one entry per window.api method
// ---------------------------------------------------------------------------
export const tauriApi: API = {
  // Auth
  authStatus: () => _invoke('auth_status'),
  authLogin: () => _invoke('auth_login'),
  authLogout: () => _invoke('auth_logout'),
  ghCliStatus: () => _invoke('gh_cli_status'),

  // Dialog
  openFolderDialog: () => _invoke('dialog_open_folder'),

  // Agent lifecycle
  createAgent: (name, cwd, provider?) => _invoke('agent_create', { name, cwd, provider }),
  closeAgent: (agentId) => _invoke('agent_close', { agentId }),
  listAgents: () => _invoke('agent_list'),

  // Agent messaging
  sendMessage: (agentId, message) => _invoke('agent_send', { agentId, message }),
  stopAgent: (agentId) => _invoke('agent_stop', { agentId }),
  respondPermission: (agentId, response: PermissionResponse) =>
    _invoke('agent_permission_respond', {
      agentId,
      requestId: response.requestId,
      behavior: response.behavior,
      updatedPermissions: response.updatedPermissions,
      updatedInput: response.updatedInput,
    }),
  listSessions: (agentId, cwd?) => _invoke('agent_list_sessions', { agentId, cwd }),
  resumeSession: (agentId, sessionId) => _invoke('agent_resume', { agentId, sessionId }),
  continueSession: (agentId) => _invoke('agent_continue', { agentId }),
  renameAgent: (agentId, name) => _invoke('agent_rename', { agentId, name }),
  renameSession: (sessionId, title) => _invoke('agent_rename_session', { sessionId, title }),
  cliRun: (args, cwd?) => _invoke('cli_run', { args, cwd }),
  emitSystemMessage: (agentId, text) => _invoke('agent_emit_system', { agentId, text }),
  setPermissionMode: (agentId, mode) => _invoke('agent_set_permission_mode', { agentId, mode }),
  getPermissionMode: (agentId) => _invoke('agent_get_permission_mode', { agentId }),
  clearSession: (agentId) => _invoke('agent_clear_session', { agentId }),

  // Usage
  fetchUsage: () => _invoke('usage_fetch'),

  // Model
  getModelInfo: (agentId) => _invoke('agent_get_model', { agentId }),
  setModel: (agentId, model) => _invoke('agent_set_model', { agentId, model }),

  // File system
  readDir: (path) => _invoke('fs_read_dir', { path }),
  readFile: (path, cwd?) => _invoke('fs_read_file', { path, cwd }),
  writeFile: (path, content) => _invoke('fs_write_file', { path, content }),
  gitDiff: (path, cwd?) => _invoke('fs_git_diff', { path, cwd }),
  gitStatus: (cwd) => _invoke('fs_git_status', { cwd }),
  gitStatusDetailed: (cwd) => _invoke('fs_git_status_detailed', { cwd }),
  gitStage: (path, cwd) => _invoke('fs_git_stage', { path, cwd }),
  gitUnstage: (path, cwd) => _invoke('fs_git_unstage', { path, cwd }),
  gitDiscard: (path, cwd) => _invoke('fs_git_discard', { path, cwd }),
  gitCommit: (message, cwd) => _invoke('fs_git_commit', { message, cwd }),
  searchFiles: (cwd, query, limit?) => _invoke('fs_search_files', { cwd, query, limit }),

  // CLI install
  installCLI: () => _invoke('cli_install'),
  uninstallCLI: () => _invoke('cli_uninstall'),
  isCLIInstalled: () => _invoke('cli_is_installed'),

  // Terminal
  createTerminal: (agentId, cwd) => _invoke('term_create', { agentId, cwd }),
  createClaudeTerminal: (agentId, cwd, resume?) => _invoke('term_create_claude', { agentId, cwd, resume }),
  createCodexTerminal: (agentId, cwd) => _invoke('term_create_codex', { agentId, cwd }),
  getTerminalBuffer: (terminalId) => _invoke('term_buffer', { terminalId }),
  writeTerminal: (terminalId, data) => _invoke('term_write', { terminalId, data }),
  resizeTerminal: (terminalId, cols, rows) => _invoke('term_resize', { terminalId, cols, rows }),
  closeTerminal: (terminalId) => _invoke('term_close', { terminalId }),
  writeToAgentTerminal: (agentId, data) => _invoke('term_write_agent', { agentId, data }),

  // Providers
  listProviders: () => _invoke('provider_list'),
  detectProviders: () => _invoke('provider_detect'),
  setProviderApiKey: (provider: ProviderId, key) => _invoke('provider_set_api_key', { provider, key }),
  hasProviderApiKey: (provider: ProviderId) => _invoke('provider_has_api_key', { provider }),

  // Window pill mode
  minimizeToPill: (agentCount) => _invoke('window_minimize_pill', { agentCount }),
  restoreFromPill: () => _invoke('window_restore_pill'),

  // Logging
  getLogUsage: () => _invoke('log_get_usage'),
  getLogPath: () => _invoke('log_get_path'),

  // Auto-update
  checkForUpdates: () => _invoke('update_check'),
  downloadUpdate: () => _invoke('update_download'),
  installUpdate: () => _invoke('update_install'),
  setGitHubToken: (token) => _invoke('update_set_gh_token', { token }),
  hasGitHubToken: () => _invoke('update_has_gh_token'),
  removeGitHubToken: () => _invoke('update_remove_gh_token'),
  onUpdateStatus: (cb) => _listen<any>('update://status', cb),

  // Events
  onAgentMessage: (cb) => _listen<any>('agent://message', cb),
  onAgentMessageBatch: (cb) => _listen<any>('agent://message-batch', cb),
  onPermissionRequest: (cb) => _listen<any>('agent://permission-request', cb),
  onPermissionDismissed: (cb) => _listen<any>('agent://permission-dismissed', cb),
  onSessionStarted: (cb) => _listen<any>('agent://session-started', cb),
  onSessionEnded: (cb) => _listen<any>('agent://session-ended', cb),
  onAgentPhase: (cb) => _listen<any>('agent://phase', cb),
  onTerminalData: (cb) => _listen<any>('term://data', cb),
  onTerminalExit: (cb) => _listen<any>('term://exit', cb),
  onInitialCwd: (cb) => _listen<string>('app://initial-cwd', cb),
  onResourceStats: (cb) => _listen<any>('app://resource-stats', cb),
  onCodexStatus: (cb) => _listen<any>('codex://status', cb),

  // Resource stats
  getResourceStats: () => _invoke('resource_stats'),
}

// Named export matching api.ts so the Vite alias swap is transparent to all importers
export const api = tauriApi
