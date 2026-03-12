import { query, listSessions } from '@anthropic-ai/claude-agent-sdk'
import type { Query, SDKMessage, SDKUserMessage, PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import { randomUUID } from 'node:crypto'
import type { BrowserWindow } from 'electron'
import { IPC } from '../shared/types'
import type { UIMessage, PermissionRequest } from '../shared/types'

// Pending permission request resolvers
const pendingPermissions = new Map<string, (result: PermissionResult) => void>()

let activeQuery: Query | null = null
let activeSessionId: string | null = null
let inputWriter: WritableStreamDefaultWriter<SDKUserMessage> | null = null
let mainWindow: BrowserWindow | null = null

export function setMainWindow(win: BrowserWindow) {
  mainWindow = win
}

function send(channel: string, data: unknown) {
  mainWindow?.webContents.send(channel, data)
}

function emitMessage(msg: UIMessage) {
  send(IPC.AGENT_MESSAGE, msg)
}

function uid(): string {
  return randomUUID().slice(0, 8)
}

export async function startSession(cwd: string, model?: string): Promise<string> {
  // Close existing session
  if (activeQuery) {
    activeQuery.close()
    activeQuery = null
  }

  // Create an async input channel for multi-turn
  const { readable, writable } = new TransformStream<SDKUserMessage>()
  inputWriter = writable.getWriter()

  const sessionId = randomUUID()
  activeSessionId = sessionId

  const q = query({
    prompt: readable as any,
    options: {
      cwd,
      model,
      includePartialMessages: true,
      canUseTool: async (toolName, input, opts) => {
        const requestId = uid()
        const req: PermissionRequest = {
          requestId,
          toolName,
          input: input as Record<string, unknown>,
          decisionReason: opts.decisionReason,
          suggestions: opts.suggestions as unknown[],
        }
        send(IPC.AGENT_PERMISSION_REQUEST, req)

        return new Promise<PermissionResult>((resolve) => {
          pendingPermissions.set(requestId, resolve)
          // Auto-deny after 5 minutes
          setTimeout(() => {
            if (pendingPermissions.has(requestId)) {
              pendingPermissions.delete(requestId)
              resolve({ behavior: 'deny', message: 'Permission request timed out' })
            }
          }, 300_000)
        })
      },
    },
  })

  activeQuery = q

  // Process messages in background
  processMessages(q, sessionId).catch(() => {})

  send(IPC.AGENT_SESSION_STARTED, { sessionId })
  return sessionId
}

async function processMessages(q: Query, sessionId: string) {
  try {
    for await (const msg of q) {
      if (activeSessionId !== sessionId) break
      const uiMsg = parseSDKMessage(msg)
      if (uiMsg) emitMessage(uiMsg)
    }
  } catch (err: any) {
    emitMessage({
      id: uid(),
      type: 'error',
      message: err?.message || 'Unknown error',
      ts: Date.now(),
    })
  } finally {
    send(IPC.AGENT_SESSION_ENDED, { sessionId })
  }
}

export async function sendMessage(message: string) {
  if (!inputWriter || !activeSessionId) {
    throw new Error('No active session')
  }

  emitMessage({
    id: uid(),
    type: 'user',
    text: message,
    ts: Date.now(),
  })

  await inputWriter.write({
    type: 'user',
    message: { role: 'user', content: message },
    parent_tool_use_id: null,
    session_id: activeSessionId,
  })
}

export function stopSession() {
  if (activeQuery) {
    activeQuery.close()
    activeQuery = null
  }
  if (inputWriter) {
    try { inputWriter.close() } catch {}
    inputWriter = null
  }
  activeSessionId = null
  // Clear pending permissions
  for (const [id, resolve] of pendingPermissions) {
    resolve({ behavior: 'deny', message: 'Session stopped' })
  }
  pendingPermissions.clear()
}

export function resolvePermission(requestId: string, behavior: 'allow' | 'deny', updatedPermissions?: unknown[]) {
  const resolver = pendingPermissions.get(requestId)
  if (!resolver) return

  pendingPermissions.delete(requestId)

  if (behavior === 'allow') {
    resolver({
      behavior: 'allow',
      updatedPermissions: updatedPermissions as any,
    })
  } else {
    resolver({
      behavior: 'deny',
      message: 'User denied',
    })
  }
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

// Accumulator for streaming text
let streamingText = ''
let streamingId = ''

function parseSDKMessage(msg: SDKMessage): UIMessage | null {
  switch (msg.type) {
    case 'system': {
      const sys = msg as any
      if (sys.subtype === 'init') {
        return {
          id: uid(),
          type: 'system',
          text: `Session started · ${sys.model} · ${sys.tools?.length || 0} tools`,
          ts: Date.now(),
        }
      }
      if (sys.subtype === 'status' && sys.status === 'compacting') {
        return {
          id: uid(),
          type: 'system',
          text: 'Compacting context...',
          ts: Date.now(),
        }
      }
      if (sys.subtype === 'task_started') {
        return {
          id: uid(),
          type: 'system',
          text: `Task started: ${sys.description}`,
          ts: Date.now(),
        }
      }
      if (sys.subtype === 'task_notification') {
        return {
          id: uid(),
          type: 'system',
          text: `Task ${sys.status}: ${sys.summary}`,
          ts: Date.now(),
        }
      }
      return null
    }

    case 'assistant': {
      // Full assistant message (non-streaming)
      const am = msg as any
      streamingText = ''
      streamingId = ''

      if (!am.message?.content) return null

      // Process content blocks
      for (const block of am.message.content) {
        if (block.type === 'text') {
          return {
            id: uid(),
            type: 'assistant',
            text: block.text,
            isStreaming: false,
            ts: Date.now(),
          }
        }
        if (block.type === 'tool_use') {
          return {
            id: uid(),
            type: 'tool-use',
            toolName: block.name,
            toolUseId: block.id,
            input: block.input,
            ts: Date.now(),
          }
        }
      }
      return null
    }

    case 'stream_event': {
      const se = msg as any
      const event = se.event
      if (!event) return null

      if (event.type === 'content_block_start') {
        if (event.content_block?.type === 'text') {
          streamingId = uid()
          streamingText = event.content_block.text || ''
          return {
            id: streamingId,
            type: 'assistant',
            text: streamingText,
            isStreaming: true,
            ts: Date.now(),
          }
        }
        if (event.content_block?.type === 'tool_use') {
          return {
            id: uid(),
            type: 'tool-use',
            toolName: event.content_block.name,
            toolUseId: event.content_block.id,
            input: {},
            ts: Date.now(),
          }
        }
      }

      if (event.type === 'content_block_delta') {
        if (event.delta?.type === 'text_delta') {
          streamingText += event.delta.text
          return {
            id: streamingId || uid(),
            type: 'assistant',
            text: streamingText,
            isStreaming: true,
            ts: Date.now(),
          }
        }
      }

      if (event.type === 'message_stop' || event.type === 'content_block_stop') {
        if (streamingText && streamingId) {
          const msg: UIMessage = {
            id: streamingId,
            type: 'assistant',
            text: streamingText,
            isStreaming: false,
            ts: Date.now(),
          }
          streamingText = ''
          streamingId = ''
          return msg
        }
      }

      return null
    }

    case 'tool_progress': {
      const tp = msg as any
      return {
        id: uid(),
        type: 'tool-progress',
        toolName: tp.tool_name,
        toolUseId: tp.tool_use_id,
        elapsed: tp.elapsed_time_seconds,
        ts: Date.now(),
      }
    }

    case 'tool_use_summary': {
      const ts = msg as any
      return {
        id: uid(),
        type: 'system',
        text: ts.summary,
        ts: Date.now(),
      }
    }

    case 'result': {
      const r = msg as any
      if (r.is_error) {
        return {
          id: uid(),
          type: 'error',
          message: r.errors?.join('\n') || r.result || 'Error',
          ts: Date.now(),
        }
      }
      return {
        id: uid(),
        type: 'result',
        cost: r.total_cost_usd || 0,
        duration: r.duration_ms || 0,
        numTurns: r.num_turns || 0,
        ts: Date.now(),
      }
    }

    case 'rate_limit_event': {
      const rl = msg as any
      if (rl.rate_limit_info?.status === 'rejected') {
        return {
          id: uid(),
          type: 'error',
          message: `Rate limited. Resets at ${new Date((rl.rate_limit_info.resetsAt || 0) * 1000).toLocaleTimeString()}`,
          ts: Date.now(),
        }
      }
      return null
    }

    case 'auth_status': {
      const as_ = msg as any
      if (as_.error) {
        return {
          id: uid(),
          type: 'error',
          message: `Auth error: ${as_.error}`,
          ts: Date.now(),
        }
      }
      return null
    }

    default:
      return null
  }
}
