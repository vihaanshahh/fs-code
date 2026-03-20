/**
 * Provider driver interface — abstracts different AI backends behind a common contract.
 * Each provider (Claude, OpenAI Codex, Gemini, Copilot) implements this interface.
 */

import type { UIMessage, PermissionMode, PermissionRequest } from '../../shared/types'

/** Returned by sendPrompt — allows the caller to close/check the running query */
export interface ProviderHandle {
  close(): void
  isRunning(): boolean
}

/** Model descriptor returned by getModels() */
export interface ModelInfo {
  value: string
  displayName: string
  description: string
}

/** Permission handler callback — providers that support permissions call this */
export type PermissionHandler = (
  toolName: string,
  input: Record<string, unknown>,
  opts: { decisionReason?: string; suggestions?: unknown[] },
) => Promise<{ behavior: 'allow' | 'deny'; message?: string; updatedInput?: Record<string, unknown>; updatedPermissions?: unknown[] }>

/** Options passed to sendPrompt */
export interface SendPromptOptions {
  /** Resume a specific session ID */
  resumeSessionId?: string | null
  /** Continue the most recent session */
  continueSession?: boolean
  /** Extra options merged into the query (e.g. for /compact, /model) */
  extraOptions?: Record<string, unknown>
  /** MCP server configs to pass to the SDK (codex intelligence tools) */
  mcpServers?: Record<string, unknown>
  /** Hook callbacks for automatic context injection */
  hooks?: Partial<Record<string, unknown[]>>
}

/**
 * Core provider interface.
 * Every AI provider must implement these methods.
 */
export interface ProviderDriver {
  /** Unique provider identifier */
  readonly id: string

  /** Human-readable name */
  readonly displayName: string

  /**
   * Check if this provider is available (CLI installed, SDK present, etc.)
   * Returns null if available, or an error message if not.
   */
  checkAvailability(): Promise<string | null>

  /**
   * Validate pre-flight conditions before sending a prompt.
   * Returns a list of fatal error messages (empty = all good).
   */
  validatePreflight(cwd: string): Promise<string[]>

  /**
   * Send a prompt and stream messages back via callbacks.
   * Returns a ProviderHandle to control the running query.
   */
  sendPrompt(
    prompt: string,
    cwd: string,
    options: SendPromptOptions,
    onMessage: (msg: UIMessage) => void,
    onStart: () => void,
    onEnd: () => void,
  ): Promise<ProviderHandle>

  /** Stop the currently running query */
  stop(): void

  /** Get available models for this provider */
  getModels(): Promise<ModelInfo[]>

  /** Switch to a specific model */
  setModel(model: string): void

  /** Get the current model identifier */
  getCurrentModel(): string

  /** Set the permission mode (not all providers support this) */
  setPermissionMode(mode: PermissionMode): void

  /** Set the permission handler callback */
  setPermissionHandler(handler: PermissionHandler): void

  /** Clean up resources */
  dispose(): void
}
