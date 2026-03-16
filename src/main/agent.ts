import { listSessions, renameSession, getSessionMessages } from '@anthropic-ai/claude-agent-sdk'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { app } from 'electron'
import type { BrowserWindow } from 'electron'
import { createProvider, type ProviderDriver, type ClaudeProvider } from './providers'

import { IPC } from '../shared/types'
import type { UIMessage, PermissionRequest, AgentDescriptor, PermissionMode, ProviderId } from '../shared/types'

// Per-agent state
interface AgentState {
  name: string
  cwd: string
  providerId: ProviderId
  provider: ProviderDriver
  activeSessionId: string | null
  pendingPermissions: Map<string, { resolve: (result: { behavior: 'allow' | 'deny'; message?: string; updatedInput?: Record<string, unknown>; updatedPermissions?: unknown[] }) => void; originalInput: Record<string, unknown>; timeoutId: ReturnType<typeof setTimeout> }>
  permissionMode: PermissionMode
  /** When set, the next sendPrompt will resume this session */
  pendingResumeId: string | null
  /** When set, the next sendPrompt will continue the most recent session */
  pendingContinue: boolean
  /** Whether we've shown the "Connected" init message (suppress on follow-ups) */
  hasShownInit: boolean
}

const agents = new Map<string, AgentState>()
let mainWindow: BrowserWindow | null = null

export function setMainWindow(win: BrowserWindow) {
  mainWindow = win
}

function send(channel: string, data: unknown) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data)
  }
}

function uid(): string {
  return randomUUID().slice(0, 8)
}

// --- Agent lifecycle ---

export function createAgent(name: string, cwd: string, providerId: ProviderId = 'claude'): AgentDescriptor {
  const id = uid()
  const provider = createProvider(providerId)

  const state: AgentState = {
    name,
    cwd,
    providerId,
    provider,
    activeSessionId: null,
    pendingPermissions: new Map(),
    permissionMode: 'default',
    pendingResumeId: null,
    pendingContinue: false,
    hasShownInit: false,
  }

  // Set up permission handler on the provider
  provider.setPermissionHandler(makePermissionHandler(id, state))

  agents.set(id, state)
  return { id, name, cwd, isActive: false, provider: providerId }
}

export function closeAgent(agentId: string): boolean {
  const state = agents.get(agentId)
  if (!state) return false
  // Stop any active query
  state.provider.stop()
  // Deny all pending permissions and clear their timeouts
  for (const [requestId, { resolve, timeoutId }] of state.pendingPermissions) {
    clearTimeout(timeoutId)
    send(IPC.AGENT_PERMISSION_DISMISSED, { agentId, requestId })
    resolve({ behavior: 'deny', message: 'Agent closed' })
  }
  state.pendingPermissions.clear()
  state.provider.dispose()
  agents.delete(agentId)
  return true
}

export function listAgents(): AgentDescriptor[] {
  return Array.from(agents.entries()).map(([id, s]) => ({
    id,
    name: s.name,
    cwd: s.cwd,
    isActive: s.activeSessionId !== null,
    provider: s.providerId,
  }))
}

// --- Messaging ---

function makePermissionHandler(agentId: string, state: AgentState) {
  return async (toolName: string, input: Record<string, unknown>, opts: { decisionReason?: string; suggestions?: unknown[] }) => {
    const currentState = agents.get(agentId)
    if (!currentState) return { behavior: 'deny' as const, message: 'Agent not found' }

    const requestId = uid()
    console.log(`[agent:${agentId}] canUseTool: ${toolName} req=${requestId} inputKeys=${Object.keys(input).join(',')}`)
    const req: PermissionRequest = {
      requestId,
      toolName,
      input,
      decisionReason: opts.decisionReason,
      suggestions: opts.suggestions as unknown[],
    }
    send(IPC.AGENT_PERMISSION_REQUEST, { agentId, ...req })

    return new Promise<{ behavior: 'allow' | 'deny'; message?: string; updatedInput?: Record<string, unknown>; updatedPermissions?: unknown[] }>((resolve) => {
      const timeoutId = setTimeout(() => {
        if (currentState.pendingPermissions.has(requestId)) {
          currentState.pendingPermissions.delete(requestId)
          console.log(`[agent:${agentId}] permission timed out req=${requestId}`)
          // Notify renderer to clear the stale permission banner
          send(IPC.AGENT_PERMISSION_DISMISSED, { agentId, requestId })
          resolve({ behavior: 'deny', message: 'Permission request timed out' })
        }
      }, 120_000) // 2 minutes
      currentState.pendingPermissions.set(requestId, { resolve, originalInput: input, timeoutId })
    })
  }
}

function emitMessage(agentId: string, msg: UIMessage) {
  send(IPC.AGENT_MESSAGE, { agentId, ...msg })
}

export async function sendPrompt(agentId: string, message: string): Promise<string> {
  const state = agents.get(agentId)
  if (!state) throw new Error(`Agent ${agentId} not found`)

  console.log(`[agent:${agentId}] sendPrompt (${state.providerId}):`, message.slice(0, 80))

  // Validate CWD with fallback
  let cwd = state.cwd || process.cwd()
  if (!existsSync(cwd)) {
    const fallback = app.getPath('home')
    console.warn(`[agent:${agentId}] cwd "${cwd}" not found, falling back to ${fallback}`)
    emitMessage(agentId, { id: uid(), type: 'system', text: `Folder not found, using ${fallback}`, ts: Date.now() })
    cwd = fallback
    state.cwd = fallback
  }

  // Preflight validation via provider
  const preflightErrors = await state.provider.validatePreflight(cwd)
  if (preflightErrors.length > 0) {
    for (const err of preflightErrors) {
      emitMessage(agentId, { id: uid(), type: 'error', message: err, ts: Date.now() })
    }
    return ''
  }

  const sessionId = randomUUID()
  state.activeSessionId = sessionId

  // Build options for the provider
  const options = {
    resumeSessionId: state.pendingResumeId,
    continueSession: state.pendingContinue,
  }

  // Clear pending flags
  if (state.pendingResumeId) {
    console.log(`[agent:${agentId}] applying pending resume: ${state.pendingResumeId}`)
    state.pendingResumeId = null
  }
  if (state.pendingContinue) {
    console.log(`[agent:${agentId}] applying pending continue`)
    state.pendingContinue = false
  }

  // Also pass current SDK session ID for auto-resume (Claude-specific, handled in provider)
  const claudeProvider = state.provider as any
  if (state.providerId === 'claude' && claudeProvider.sessionId && !options.resumeSessionId) {
    options.resumeSessionId = claudeProvider.sessionId
    console.log(`[agent:${agentId}] auto-resuming SDK session: ${options.resumeSessionId}`)
  }

  // Delegate to provider
  state.provider.sendPrompt(
    message,
    cwd,
    options,
    (msg) => emitMessage(agentId, msg),
    () => send(IPC.AGENT_SESSION_STARTED, { agentId, sessionId }),
    () => {
      const current = agents.get(agentId)
      if (current && current.activeSessionId === sessionId) {
        current.activeSessionId = null
      }
      send(IPC.AGENT_SESSION_ENDED, { agentId, sessionId })
    },
  ).catch((err) => {
    console.error(`[agent:${agentId}] sendPrompt error:`, err)
    emitMessage(agentId, { id: uid(), type: 'error', message: err?.message || String(err), ts: Date.now() })
    // Clear activeSessionId so agent doesn't appear permanently stuck
    const current = agents.get(agentId)
    if (current && current.activeSessionId === sessionId) {
      current.activeSessionId = null
    }
    send(IPC.AGENT_SESSION_ENDED, { agentId, sessionId })
  })

  return sessionId
}

export function stopSession(agentId: string) {
  const state = agents.get(agentId)
  if (!state) return
  state.provider.stop()
  state.activeSessionId = null
  for (const [requestId, { resolve, timeoutId }] of state.pendingPermissions) {
    clearTimeout(timeoutId)
    send(IPC.AGENT_PERMISSION_DISMISSED, { agentId, requestId })
    resolve({ behavior: 'deny', message: 'Session stopped' })
  }
  state.pendingPermissions.clear()
}

export async function setPermissionMode(agentId: string, mode: string): Promise<string> {
  const state = agents.get(agentId)
  if (!state) throw new Error(`Agent ${agentId} not found`)

  const validModes = ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'dontAsk']
  if (!validModes.includes(mode)) throw new Error(`Invalid mode: ${mode}`)

  state.permissionMode = mode as PermissionMode
  state.provider.setPermissionMode(mode as PermissionMode)

  console.log(`[agent:${agentId}] permissionMode → ${mode}`)
  return mode
}

export function getPermissionMode(agentId: string): string {
  const state = agents.get(agentId)
  return state?.permissionMode || 'default'
}

export function resolvePermission(agentId: string, requestId: string, behavior: 'allow' | 'deny', updatedPermissions?: unknown[], updatedInput?: Record<string, unknown>) {
  const state = agents.get(agentId)
  if (!state) {
    console.error(`[agent:${agentId}] resolvePermission: agent not found`)
    return
  }
  const pending = state.pendingPermissions.get(requestId)
  if (!pending) {
    console.error(`[agent:${agentId}] resolvePermission: no pending request ${requestId}`)
    return
  }
  state.pendingPermissions.delete(requestId)
  clearTimeout(pending.timeoutId)
  const { resolve: resolver, originalInput } = pending

  if (behavior === 'allow') {
    const result: { behavior: 'allow'; updatedInput?: Record<string, unknown>; updatedPermissions?: unknown[] } = {
      behavior: 'allow',
      updatedInput: updatedInput && Object.keys(updatedInput).length > 0 ? updatedInput : originalInput,
    }
    if (updatedPermissions) result.updatedPermissions = updatedPermissions
    console.log(`[agent:${agentId}] resolvePermission ALLOW req=${requestId}`)
    resolver(result)
  } else {
    console.log(`[agent:${agentId}] resolvePermission DENY req=${requestId}`)
    resolver({ behavior: 'deny', message: 'User denied' })
  }
}

/** Reset session state so the next message starts a fresh conversation */
export function clearSession(agentId: string) {
  const state = agents.get(agentId)
  if (!state) return
  // For Claude provider, clear SDK session ID
  if (state.providerId === 'claude') {
    const cp = state.provider as ClaudeProvider
    cp.sessionId = null
    cp.sessionShownInit = false
  }
  state.pendingResumeId = null
  state.pendingContinue = false
  state.hasShownInit = false
  console.log(`[agent:${agentId}] session cleared — next message starts fresh`)
}

export async function getSessions(agentId: string, cwd?: string) {
  const state = agents.get(agentId)
  // Session listing is only supported for Claude provider
  if (!state || state.providerId !== 'claude') return []
  const sessions = await listSessions(cwd ? { dir: cwd } : undefined)
  return sessions.map((s) => ({
    sessionId: s.sessionId,
    summary: s.summary,
    lastModified: s.lastModified,
    cwd: s.cwd,
  }))
}

// --- Resume a previous session ---

export async function resumeSession(agentId: string, resumeSessionId: string): Promise<void> {
  const state = agents.get(agentId)
  if (!state) throw new Error(`Agent ${agentId} not found`)
  if (state.providerId !== 'claude') throw new Error('Session resume is only supported for Claude provider')

  console.log(`[agent:${agentId}] resumeSession: storing ${resumeSessionId}`)

  state.pendingResumeId = resumeSessionId
  state.pendingContinue = false

  try {
    const history = await getSessionMessages(resumeSessionId, {
      dir: state.cwd || undefined,
    })
    const batch: UIMessage[] = [{
      id: uid(),
      type: 'system',
      text: `Resumed session ${resumeSessionId.slice(0, 8)} — ${history.length} messages loaded. Type your next message to continue.`,
      ts: Date.now(),
    }]
    for (const msg of history) {
      if (msg.type === 'user') {
        const text = extractText(msg.message)
        if (text) batch.push({ id: uid(), type: 'user', text, ts: Date.now() })
      } else if (msg.type === 'assistant') {
        const text = extractText(msg.message)
        if (text) batch.push({ id: uid(), type: 'assistant', text, isStreaming: false, ts: Date.now() })
      }
    }
    batch.push({ id: uid(), type: 'system', text: '— end of history — type to continue', ts: Date.now() })
    send(IPC.AGENT_MESSAGE_BATCH, { agentId, messages: batch })
  } catch (err: any) {
    console.error(`[agent:${agentId}] getSessionMessages error:`, err)
    emitMessage(agentId, {
      id: uid(),
      type: 'system',
      text: `Session ${resumeSessionId.slice(0, 8)} loaded (history not available). Type your next message to continue.`,
      ts: Date.now(),
    })
  }
}

// --- Continue most recent session ---

export async function continueSession(agentId: string): Promise<void> {
  const state = agents.get(agentId)
  if (!state) throw new Error(`Agent ${agentId} not found`)
  if (state.providerId !== 'claude') throw new Error('Session continue is only supported for Claude provider')

  console.log(`[agent:${agentId}] continueSession: storing flag`)

  state.pendingContinue = true
  state.pendingResumeId = null

  try {
    const sessions = await listSessions({ dir: state.cwd || undefined })
    if (sessions.length > 0) {
      const latest = sessions.sort((a, b) => b.lastModified - a.lastModified)[0]
      const history = await getSessionMessages(latest.sessionId, {
        dir: state.cwd || undefined,
      })
      const batch: UIMessage[] = [{
        id: uid(),
        type: 'system',
        text: `Continuing session "${latest.summary || latest.sessionId.slice(0, 8)}" — ${history.length} messages. Type your next message.`,
        ts: Date.now(),
      }]
      for (const msg of history) {
        if (msg.type === 'user') {
          const text = extractText(msg.message)
          if (text) batch.push({ id: uid(), type: 'user', text, ts: Date.now() })
        } else if (msg.type === 'assistant') {
          const text = extractText(msg.message)
          if (text) batch.push({ id: uid(), type: 'assistant', text, isStreaming: false, ts: Date.now() })
        }
      }
      batch.push({ id: uid(), type: 'system', text: '— end of history — type to continue', ts: Date.now() })
      send(IPC.AGENT_MESSAGE_BATCH, { agentId, messages: batch })
    } else {
      emitMessage(agentId, {
        id: uid(),
        type: 'system',
        text: 'No previous sessions found. Your next message will start a new conversation.',
        ts: Date.now(),
      })
      state.pendingContinue = false
    }
  } catch (err: any) {
    console.error(`[agent:${agentId}] continueSession list error:`, err)
    emitMessage(agentId, {
      id: uid(),
      type: 'system',
      text: 'Continuing most recent session. Type your next message.',
      ts: Date.now(),
    })
  }
}

/** Extract text from SDK message content (handles various formats) */
function extractText(content: unknown): string | null {
  if (!content) return null
  if (typeof content === 'string') return content
  const obj = content as any
  if (obj.content) {
    if (typeof obj.content === 'string') return obj.content
    if (Array.isArray(obj.content)) {
      const texts: string[] = []
      for (const block of obj.content) {
        if (typeof block === 'string') texts.push(block)
        else if (block?.type === 'text' && block.text) texts.push(block.text)
      }
      return texts.join('') || null
    }
  }
  if (Array.isArray(content)) {
    const texts: string[] = []
    for (const block of content) {
      if (typeof block === 'string') texts.push(block)
      else if (block?.type === 'text' && block.text) texts.push(block.text)
    }
    return texts.join('') || null
  }
  return null
}

// --- Model info ---

export async function getModelInfo(agentId: string): Promise<{ current: string; models: { value: string; displayName: string; description: string }[] }> {
  const state = agents.get(agentId)
  if (!state) throw new Error(`Agent ${agentId} not found`)

  const models = await state.provider.getModels()
  return { current: state.provider.getCurrentModel(), models }
}

export async function switchModel(agentId: string, model: string): Promise<void> {
  const state = agents.get(agentId)
  if (!state) throw new Error(`Agent ${agentId} not found`)

  state.provider.setModel(model)
  console.log(`[agent:${agentId}] model → ${model}`)
}

// --- Rename agent ---

export function renameAgentName(agentId: string, name: string): boolean {
  const state = agents.get(agentId)
  if (!state) return false
  state.name = name
  return true
}

// --- Rename session ---

export async function doRenameSession(sessionId: string, title: string): Promise<void> {
  await renameSession(sessionId, title)
}

// --- Send prompt with options (for /compact, /model, etc.) ---

export async function sendPromptWithOptions(
  agentId: string,
  message: string,
  extraOptions: Record<string, unknown>,
): Promise<string> {
  const state = agents.get(agentId)
  if (!state) throw new Error(`Agent ${agentId} not found`)

  console.log(`[agent:${agentId}] sendPromptWithOptions (${state.providerId}):`, message.slice(0, 80))

  let cwd = state.cwd || process.cwd()
  if (!existsSync(cwd)) {
    const fallback = app.getPath('home')
    cwd = fallback
    state.cwd = fallback
  }

  const preflightErrors = await state.provider.validatePreflight(cwd)
  if (preflightErrors.length > 0) {
    for (const err of preflightErrors) {
      emitMessage(agentId, { id: uid(), type: 'error', message: err, ts: Date.now() })
    }
    return ''
  }

  const sessionId = randomUUID()
  state.activeSessionId = sessionId

  const options = {
    resumeSessionId: state.pendingResumeId,
    continueSession: state.pendingContinue,
    extraOptions,
  }

  if (state.pendingResumeId) state.pendingResumeId = null
  if (state.pendingContinue) state.pendingContinue = false

  // Auto-resume for Claude
  const claudeProvider = state.provider as any
  if (state.providerId === 'claude' && claudeProvider.sessionId && !options.resumeSessionId) {
    options.resumeSessionId = claudeProvider.sessionId
  }

  state.provider.sendPrompt(
    message,
    cwd,
    options,
    (msg) => emitMessage(agentId, msg),
    () => send(IPC.AGENT_SESSION_STARTED, { agentId, sessionId }),
    () => {
      const current = agents.get(agentId)
      if (current && current.activeSessionId === sessionId) {
        current.activeSessionId = null
      }
      send(IPC.AGENT_SESSION_ENDED, { agentId, sessionId })
    },
  ).catch((err) => {
    console.error(`[agent:${agentId}] sendPromptWithOptions error:`, err)
  })

  return sessionId
}
