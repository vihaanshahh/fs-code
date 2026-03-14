import { query, listSessions, renameSession, getSessionMessages } from '@anthropic-ai/claude-agent-sdk'
import type { Query, SDKMessage, PermissionResult, ModelInfo } from '@anthropic-ai/claude-agent-sdk'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { app } from 'electron'
import type { BrowserWindow } from 'electron'

// Resolve the path to the SDK's cli.js executable.
// In production, electron-builder unpacks it from the ASAR to app.asar.unpacked/.
function getCliPath(): string {
  const sdkCliRel = join('node_modules', '@anthropic-ai', 'claude-agent-sdk', 'cli.js')
  if (app.isPackaged) {
    // electron-builder places asarUnpack files at app.asar.unpacked/
    return join(process.resourcesPath, 'app.asar.unpacked', sdkCliRel)
  }
  return join(app.getAppPath(), sdkCliRel)
}

import { IPC } from '../shared/types'
import type { UIMessage, PermissionRequest, AgentDescriptor, PermissionMode } from '../shared/types'

// Per-agent state
interface AgentState {
  name: string
  cwd: string
  activeQuery: Query | null
  activeSessionId: string | null
  streamingText: string
  streamingId: string
  pendingPermissions: Map<string, { resolve: (result: PermissionResult) => void; originalInput: Record<string, unknown>; timeoutId: ReturnType<typeof setTimeout> }>
  permissionMode: PermissionMode
  /** When set, the next sendPrompt will resume this session */
  pendingResumeId: string | null
  /** When set, the next sendPrompt will continue the most recent session */
  pendingContinue: boolean
  /** SDK session ID from last completed query — auto-resumed on next message */
  sdkSessionId: string | null
  /** Whether we've shown the "Connected" init message (suppress on follow-ups) */
  hasShownInit: boolean
  /** Current model from last init */
  currentModel: string
}

const agents = new Map<string, AgentState>()
let mainWindow: BrowserWindow | null = null

export function setMainWindow(win: BrowserWindow) {
  mainWindow = win
}

function send(channel: string, data: unknown) {
  mainWindow?.webContents.send(channel, data)
}

function uid(): string {
  return randomUUID().slice(0, 8)
}

// --- Agent lifecycle ---

export function createAgent(name: string, cwd: string): AgentDescriptor {
  const id = uid()
  agents.set(id, {
    name,
    cwd,
    activeQuery: null,
    activeSessionId: null,
    streamingText: '',
    streamingId: '',
    pendingPermissions: new Map(),
    permissionMode: 'default',
    pendingResumeId: null,
    pendingContinue: false,
    sdkSessionId: null,
    hasShownInit: false,
    currentModel: '',
  })
  return { id, name, cwd, isActive: false }
}

export function closeAgent(agentId: string): boolean {
  const state = agents.get(agentId)
  if (!state) return false
  // Stop any active query
  if (state.activeQuery) {
    state.activeQuery.close()
  }
  // Deny all pending permissions and clear their timeouts
  for (const [, { resolve, timeoutId }] of state.pendingPermissions) {
    clearTimeout(timeoutId)
    resolve({ behavior: 'deny', message: 'Agent closed' })
  }
  state.pendingPermissions.clear()
  agents.delete(agentId)
  return true
}

export function listAgents(): AgentDescriptor[] {
  return Array.from(agents.entries()).map(([id, s]) => ({
    id,
    name: s.name,
    cwd: s.cwd,
    isActive: s.activeQuery !== null,
  }))
}

// --- Messaging ---

function makePermissionHandler(agentId: string) {
  return async (toolName: string, input: Record<string, unknown>, opts: any): Promise<PermissionResult> => {
    const state = agents.get(agentId)
    if (!state) return { behavior: 'deny', message: 'Agent not found' }

    // Auto-approve SDK internal tools that should not require user interaction
    const autoApproveTools = ['ExitPlanMode', 'EnterPlanMode', 'ExitWorktree', 'EnterWorktree']
    if (autoApproveTools.includes(toolName)) {
      console.log(`[agent:${agentId}] canUseTool: auto-approving internal tool ${toolName}`)
      return { behavior: 'allow', updatedInput: input }
    }

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

    return new Promise<PermissionResult>((resolve) => {
      const timeoutId = setTimeout(() => {
        if (state.pendingPermissions.has(requestId)) {
          state.pendingPermissions.delete(requestId)
          resolve({ behavior: 'deny', message: 'Permission request timed out' })
        }
      }, 300_000)
      state.pendingPermissions.set(requestId, { resolve, originalInput: input, timeoutId })
    })
  }
}

function emitMessage(agentId: string, msg: UIMessage) {
  send(IPC.AGENT_MESSAGE, { agentId, ...msg })
}

export async function sendPrompt(agentId: string, message: string): Promise<string> {
  const state = agents.get(agentId)
  if (!state) throw new Error(`Agent ${agentId} not found`)

  console.log(`[agent:${agentId}] sendPrompt:`, message.slice(0, 80))

  // Close existing query
  if (state.activeQuery) {
    state.activeQuery.close()
    state.activeQuery = null
  }

  const sessionId = randomUUID()
  state.activeSessionId = sessionId

  // Emit user message
  emitMessage(agentId, {
    id: uid(),
    type: 'user',
    text: message,
    ts: Date.now(),
  })

  // Build query options, applying any pending resume/continue
  const opts: Record<string, unknown> = {
    pathToClaudeCodeExecutable: getCliPath(),
    executable: process.execPath,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    cwd: state.cwd || process.cwd(),
    includePartialMessages: true,
    canUseTool: makePermissionHandler(agentId),
    permissionMode: state.permissionMode,
  }
  if (state.pendingResumeId) {
    opts.resume = state.pendingResumeId
    state.pendingResumeId = null
    console.log(`[agent:${agentId}] applying pending resume: ${opts.resume}`)
  } else if (state.pendingContinue) {
    opts.continue = true
    state.pendingContinue = false
    console.log(`[agent:${agentId}] applying pending continue`)
  } else if (state.sdkSessionId) {
    // Auto-resume the previous SDK session so conversation continues seamlessly
    opts.resume = state.sdkSessionId
    console.log(`[agent:${agentId}] auto-resuming SDK session: ${state.sdkSessionId}`)
  }

  // Log the exact options being passed to SDK
  const { canUseTool, ...loggableOpts } = opts
  console.log(`[agent:${agentId}] query options:`, JSON.stringify(loggableOpts))

  // Start query
  const q = query({
    prompt: message,
    options: opts as any,
  })

  state.activeQuery = q
  send(IPC.AGENT_SESSION_STARTED, { agentId, sessionId })

  // Process messages in background
  processMessages(agentId, q, sessionId).catch((err) => {
    console.error(`[agent:${agentId}] processMessages error:`, err)
  })

  return sessionId
}

async function processMessages(agentId: string, q: Query, sessionId: string) {
  const state = agents.get(agentId)
  if (!state) return

  try {
    for await (const msg of q) {
      // Check agent still exists and session matches
      const current = agents.get(agentId)
      if (!current || current.activeSessionId !== sessionId) break
      const uiMsgs = parseSDKMessage(current, msg)
      for (const m of uiMsgs) emitMessage(agentId, m)
    }
  } catch (err: any) {
    console.error(`[agent:${agentId}] stream error:`, err)
    const msg = err?.message || String(err) || 'Unknown error'
    const isAuth = /auth|unauthorized|401|not.?logged.?in|not.?authenticated|invalid.?token/i.test(msg)
    emitMessage(agentId, {
      id: uid(),
      type: 'error',
      message: isAuth ? 'Not authenticated — use /login or click Sign In in the status bar' : msg,
      ts: Date.now(),
    })
  } finally {
    const current = agents.get(agentId)
    if (current && current.activeSessionId === sessionId) {
      current.activeQuery = null
    }
    send(IPC.AGENT_SESSION_ENDED, { agentId, sessionId })
  }
}

export function stopSession(agentId: string) {
  const state = agents.get(agentId)
  if (!state) return
  if (state.activeQuery) {
    state.activeQuery.close()
    state.activeQuery = null
  }
  state.activeSessionId = null
  for (const [, { resolve, timeoutId }] of state.pendingPermissions) {
    clearTimeout(timeoutId)
    resolve({ behavior: 'deny', message: 'Session stopped' })
  }
  state.pendingPermissions.clear()
}

export async function setPermissionMode(agentId: string, mode: string): Promise<string> {
  const state = agents.get(agentId)
  if (!state) throw new Error(`Agent ${agentId} not found`)

  const validModes = ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'dontAsk']
  if (!validModes.includes(mode)) throw new Error(`Invalid mode: ${mode}`)

  state.permissionMode = mode as any

  // If there's an active query, change its mode live
  if (state.activeQuery) {
    try {
      await state.activeQuery.setPermissionMode(mode as any)
    } catch (err) {
      console.log(`[agent:${agentId}] setPermissionMode on active query failed (non-streaming):`, err)
    }
  }

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
    // Pass the user's modified input if provided, otherwise preserve the original tool input
    const result: PermissionResult = { behavior: 'allow', updatedInput: updatedInput && Object.keys(updatedInput).length > 0 ? updatedInput : originalInput }
    if (updatedPermissions) result.updatedPermissions = updatedPermissions as any
    console.log(`[agent:${agentId}] resolvePermission ALLOW req=${requestId} hasUpdatedInput=${!!updatedInput} keys=${updatedInput ? Object.keys(updatedInput).join(',') : 'none'}`)
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
  state.sdkSessionId = null
  state.hasShownInit = false
  state.pendingResumeId = null
  state.pendingContinue = false
  console.log(`[agent:${agentId}] session cleared — next message starts fresh`)
}

export async function getSessions(cwd?: string) {
  const sessions = await listSessions(cwd ? { dir: cwd } : undefined)
  return sessions.map((s) => ({
    sessionId: s.sessionId,
    summary: s.summary,
    lastModified: s.lastModified,
    cwd: s.cwd,
  }))
}

// --- Resume a previous session ---
// Stores the session ID and loads history. The NEXT sendPrompt will use `resume`.

export async function resumeSession(agentId: string, resumeSessionId: string): Promise<void> {
  const state = agents.get(agentId)
  if (!state) throw new Error(`Agent ${agentId} not found`)

  console.log(`[agent:${agentId}] resumeSession: storing ${resumeSessionId}`)

  // Store for next sendPrompt
  state.pendingResumeId = resumeSessionId
  state.pendingContinue = false

  // Load and display previous messages from the session
  try {
    const history = await getSessionMessages(resumeSessionId, {
      dir: state.cwd || undefined,
    })
    // Batch all history messages into a single IPC send
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
// Stores continue flag. The NEXT sendPrompt will use `continue: true`.

export async function continueSession(agentId: string): Promise<void> {
  const state = agents.get(agentId)
  if (!state) throw new Error(`Agent ${agentId} not found`)

  console.log(`[agent:${agentId}] continueSession: storing flag`)

  state.pendingContinue = true
  state.pendingResumeId = null

  // Try to load recent session history
  try {
    const sessions = await listSessions({ dir: state.cwd || undefined })
    if (sessions.length > 0) {
      const latest = sessions.sort((a, b) => b.lastModified - a.lastModified)[0]
      // Load messages from the most recent session
      const history = await getSessionMessages(latest.sessionId, {
        dir: state.cwd || undefined,
      })
      // Batch all history messages into a single IPC send
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
  // String
  if (typeof content === 'string') return content
  // { content: [...] } or { content: "..." }
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
  // Array of content blocks
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

  let models: { value: string; displayName: string; description: string }[] = []
  if (state.activeQuery) {
    try {
      const supported = await state.activeQuery.supportedModels()
      models = supported.map(m => ({ value: m.value, displayName: m.displayName, description: m.description }))
    } catch { /* no active query */ }
  }

  return { current: state.currentModel, models }
}

export async function switchModel(agentId: string, model: string): Promise<void> {
  const state = agents.get(agentId)
  if (!state) throw new Error(`Agent ${agentId} not found`)

  if (state.activeQuery) {
    await state.activeQuery.setModel(model)
  }
  state.currentModel = model
  console.log(`[agent:${agentId}] model → ${model}`)
}

// --- Rename agent (update in-memory name) ---

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

  console.log(`[agent:${agentId}] sendPromptWithOptions:`, message.slice(0, 80))

  if (state.activeQuery) {
    state.activeQuery.close()
    state.activeQuery = null
  }

  const sessionId = randomUUID()
  state.activeSessionId = sessionId

  if (message) {
    emitMessage(agentId, { id: uid(), type: 'user', text: message, ts: Date.now() })
  }

  // Build query options — must include CLI path/executable/env just like sendPrompt
  const opts: Record<string, unknown> = {
    pathToClaudeCodeExecutable: getCliPath(),
    executable: process.execPath,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    cwd: state.cwd || process.cwd(),
    includePartialMessages: true,
    canUseTool: makePermissionHandler(agentId),
    permissionMode: state.permissionMode,
  }

  // Apply session resume logic (same as sendPrompt)
  if (state.pendingResumeId) {
    opts.resume = state.pendingResumeId
    state.pendingResumeId = null
    console.log(`[agent:${agentId}] sendPromptWithOptions applying pending resume: ${opts.resume}`)
  } else if (state.pendingContinue) {
    opts.continue = true
    state.pendingContinue = false
    console.log(`[agent:${agentId}] sendPromptWithOptions applying pending continue`)
  } else if (state.sdkSessionId) {
    opts.resume = state.sdkSessionId
    console.log(`[agent:${agentId}] sendPromptWithOptions auto-resuming SDK session: ${state.sdkSessionId}`)
  }

  const q = query({
    prompt: message,
    options: {
      ...opts,
      ...extraOptions,
    } as any,
  })

  state.activeQuery = q
  send(IPC.AGENT_SESSION_STARTED, { agentId, sessionId })

  processMessages(agentId, q, sessionId).catch((err) => {
    console.error(`[agent:${agentId}] sendPromptWithOptions error:`, err)
  })

  return sessionId
}

// --- SDK message parsing (per-agent streaming state) ---

function parseSDKMessage(state: AgentState, msg: SDKMessage): UIMessage[] {
  const out: UIMessage[] = []
  // Debug: log message types to trace usage data flow
  const debugTypes = new Set(['rate_limit_event', 'result', 'auth_status'])
  if (debugTypes.has(msg.type)) {
    console.log(`[SDK:${msg.type}]`, JSON.stringify(msg).slice(0, 800))
  }
  switch (msg.type) {
    case 'system': {
      const sys = msg as any
      if (sys.subtype === 'init') {
        if (sys.model) state.currentModel = sys.model
        // Only show "Connected" on first init, suppress on auto-resumed follow-ups
        if (!state.hasShownInit) {
          state.hasShownInit = true
          out.push({ id: uid(), type: 'system', text: `Connected · ${sys.model}`, ts: Date.now() })
        }
      } else if (sys.subtype === 'status' && sys.status === 'compacting') {
        out.push({ id: uid(), type: 'system', text: 'Compacting context...', ts: Date.now() })
      } else if (sys.subtype === 'task_started') {
        out.push({ id: uid(), type: 'system', text: `Task: ${sys.description}`, ts: Date.now() })
      } else if (sys.subtype === 'task_notification') {
        out.push({ id: uid(), type: 'system', text: `Task ${sys.status}: ${sys.summary}`, ts: Date.now() })
      } else if (sys.subtype === 'local_command_output') {
        // Output from slash commands handled natively by Claude Code (e.g. /cost, /usage, /doctor)
        out.push({ id: uid(), type: 'system', text: sys.content || '', ts: Date.now() })
      }
      return out
    }

    case 'assistant': {
      const am = msg as any
      state.streamingText = ''
      state.streamingId = ''
      if (!am.message?.content) return out
      for (const block of am.message.content) {
        if (block.type === 'text') {
          out.push({ id: uid(), type: 'assistant', text: block.text, isStreaming: false, ts: Date.now() })
        } else if (block.type === 'tool_use') {
          out.push({ id: uid(), type: 'tool-use', toolName: block.name, toolUseId: block.id, input: block.input, ts: Date.now() })
        }
      }
      // Emit token usage from the message if available
      if (am.message?.usage) {
        const u = am.message.usage
        if (u.input_tokens || u.output_tokens) {
          out.push({ id: uid(), type: 'token-usage', inputTokens: u.input_tokens || 0, outputTokens: u.output_tokens || 0, ts: Date.now() })
        }
      }
      return out
    }

    case 'stream_event': {
      const se = msg as any
      const event = se.event
      if (!event) return out

      if (event.type === 'content_block_start') {
        if (event.content_block?.type === 'text') {
          state.streamingId = uid()
          state.streamingText = event.content_block.text || ''
          out.push({ id: state.streamingId, type: 'assistant', text: state.streamingText, isStreaming: true, ts: Date.now() })
        } else if (event.content_block?.type === 'tool_use') {
          out.push({ id: uid(), type: 'tool-use', toolName: event.content_block.name, toolUseId: event.content_block.id, input: {}, ts: Date.now() })
        }
      } else if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        state.streamingText += event.delta.text
        out.push({ id: state.streamingId || uid(), type: 'assistant', text: state.streamingText, isStreaming: true, ts: Date.now() })
      } else if (event.type === 'message_stop' || event.type === 'content_block_stop') {
        if (state.streamingText && state.streamingId) {
          out.push({ id: state.streamingId, type: 'assistant', text: state.streamingText, isStreaming: false, ts: Date.now() })
          state.streamingText = ''
          state.streamingId = ''
        }
      }
      // Capture usage from message_delta events (Anthropic sends usage here)
      if (event.type === 'message_delta' && event.usage) {
        const u = event.usage
        out.push({ id: uid(), type: 'token-usage', inputTokens: u.input_tokens || 0, outputTokens: u.output_tokens || 0, ts: Date.now() })
      }
      return out
    }

    case 'tool_progress': {
      const tp = msg as any
      out.push({ id: uid(), type: 'tool-progress', toolName: tp.tool_name, toolUseId: tp.tool_use_id, elapsed: tp.elapsed_time_seconds, ts: Date.now() })
      return out
    }

    case 'tool_use_summary': {
      const ts = msg as any
      out.push({ id: uid(), type: 'system', text: ts.summary, ts: Date.now() })
      return out
    }

    case 'result': {
      const r = msg as any
      // Capture SDK session ID so we can auto-resume on the next message
      if (r.session_id) {
        state.sdkSessionId = r.session_id
        console.log(`[agent] captured SDK session: ${r.session_id}`)
      }
      if (r.is_error) {
        out.push({ id: uid(), type: 'error', message: r.errors?.join('\n') || r.result || 'Error', ts: Date.now() })
      } else {
        out.push({ id: uid(), type: 'result', cost: r.total_cost_usd || 0, duration: r.duration_ms || 0, numTurns: r.num_turns || 0, ts: Date.now() })
      }
      // Emit token usage from result
      if (r.usage) {
        out.push({ id: uid(), type: 'token-usage', inputTokens: r.usage.input_tokens || 0, outputTokens: r.usage.output_tokens || 0, ts: Date.now() })
      }
      // Emit per-model usage (contextWindow, tokens) for context fill tracking
      if (r.modelUsage) {
        for (const [model, mu] of Object.entries(r.modelUsage)) {
          const m = mu as any
          if (m.contextWindow && m.inputTokens) {
            out.push({
              id: uid(),
              type: 'usage' as const,
              utilization: (m.inputTokens + m.outputTokens + (m.cacheReadInputTokens || 0) + (m.cacheCreationInputTokens || 0)) / m.contextWindow,
              resetsAt: null,
              limitType: 'context_window',
              status: 'allowed',
              ts: Date.now(),
            })
            break // only need one model's context fill
          }
        }
      }
      return out
    }

    case 'rate_limit_event': {
      const rl = msg as any
      const info = rl.rate_limit_info
      if (!info) return out

      if (info.status === 'rejected') {
        const resetsIn = info.resetsAt ? Math.max(0, Math.round((info.resetsAt * 1000 - Date.now()) / 60000)) : null
        out.push({ id: uid(), type: 'error', message: `Rate limited${resetsIn ? ` — resets in ${resetsIn}m` : ''}`, ts: Date.now() })
      }

      // Always forward utilization data so the UI can track real usage
      if (typeof info.utilization === 'number') {
        out.push({
          id: uid(),
          type: 'usage' as const,
          utilization: info.utilization,
          resetsAt: info.resetsAt ? info.resetsAt * 1000 : null,
          limitType: info.rateLimitType || 'unknown',
          status: info.status || 'allowed',
          ts: Date.now(),
        })
      }
      return out
    }

    case 'auth_status': {
      const a = msg as any
      if (a.error) out.push({ id: uid(), type: 'error', message: `Auth error: ${a.error}. Use /login to sign in.`, ts: Date.now() })
      else if (a.account?.email) out.push({ id: uid(), type: 'system', text: `Signed in as ${a.account.email}`, ts: Date.now() })
      return out
    }

    default:
      return out
  }
}
