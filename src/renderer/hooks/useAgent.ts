import { useState, useEffect, useCallback, useSyncExternalStore } from 'react'
import { api } from '../lib/api'
import type { UIMessage, PermissionRequest } from '../../shared/types'

// ── Global message cache ──
// Messages persist here across component mount/unmount cycles (e.g. pill mode).
// IPC listeners run once at module load — they never tear down.

/** Max messages kept per agent to prevent unbounded memory growth.
 *  200 per agent × 9 agents = 1800 messages total — handles 2-3× load headroom. */
const MAX_MESSAGES = 200

/** Truncate large strings in tool-use inputs to cap per-message memory */
const MAX_TOOL_INPUT_CHARS = 4000

interface AgentState {
  messages: UIMessage[]
  isActive: boolean
  permissionRequest: PermissionRequest | null
}

/** Trim messages array to MAX_MESSAGES, keeping the most recent ones */
function trimMessages(msgs: UIMessage[]): UIMessage[] {
  return msgs.length > MAX_MESSAGES ? msgs.slice(-MAX_MESSAGES) : msgs
}

/** Truncate tool-use input values that are too large for the renderer */
function truncateToolInput(msg: UIMessage): UIMessage {
  if (msg.type !== 'tool-use' || !msg.input) return msg
  const input = msg.input as Record<string, unknown>
  let changed = false
  const trimmed: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === 'string' && v.length > MAX_TOOL_INPUT_CHARS) {
      trimmed[k] = v.slice(0, MAX_TOOL_INPUT_CHARS) + `\n... (${v.length - MAX_TOOL_INPUT_CHARS} chars truncated)`
      changed = true
    } else {
      trimmed[k] = v
    }
  }
  return changed ? { ...msg, input: trimmed } : msg
}

const cache = new Map<string, AgentState>()
const listeners = new Set<() => void>()

/** Pending streaming text that hasn't been flushed to React state yet */
const pendingStreaming = new Map<string, UIMessage>()
let flushScheduled = false

/**
 * Coalesced notification: batch all listener notifications into a single RAF.
 * Under heavy load (9+ agents streaming), this prevents O(listeners × messages)
 * React re-renders per frame — notifications collapse into at most 1 per frame.
 */
let notifyScheduled = false
function notifyListeners() {
  if (notifyScheduled) return
  notifyScheduled = true
  requestAnimationFrame(() => {
    notifyScheduled = false
    listeners.forEach(fn => fn())
  })
}

function getState(agentId: string): AgentState {
  let s = cache.get(agentId)
  if (!s) {
    s = { messages: [], isActive: false, permissionRequest: null }
    cache.set(agentId, s)
  }
  return s
}

function setState(agentId: string, updater: (prev: AgentState) => AgentState) {
  const prev = getState(agentId)
  const next = updater(prev)
  if (next !== prev) {
    cache.set(agentId, next)
    notifyListeners()
  }
}

/** Flush all pending streaming updates in a single RAF tick */
function scheduleFlush() {
  if (flushScheduled) return
  flushScheduled = true
  requestAnimationFrame(() => {
    flushScheduled = false
    if (pendingStreaming.size === 0) return
    // Batch: apply all pending streaming updates, then notify once
    for (const [agentId, msg] of pendingStreaming) {
      const prev = getState(agentId)
      const msgs = prev.messages
      const last = msgs[msgs.length - 1]
      if (last?.type === 'assistant' && last.isStreaming) {
        const updated = msgs.slice()
        updated[updated.length - 1] = msg
        cache.set(agentId, { ...prev, messages: updated })
      } else {
        cache.set(agentId, { ...prev, messages: trimMessages([...msgs, msg]) })
      }
    }
    pendingStreaming.clear()
    // Direct notify (we're already inside RAF, no need to schedule another)
    notifyScheduled = false
    listeners.forEach(fn => fn())
  })
}

function subscribe(cb: () => void) {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

// ── Always-on IPC listeners (registered once at module load) ──

api.onAgentMessage((data: any) => {
  const agentId = data.agentId as string
  if (!agentId) return // guard against malformed IPC
  const msg: UIMessage = data

  // Streaming deltas: buffer and flush on next animation frame
  if (msg.type === 'assistant' && msg.isStreaming) {
    pendingStreaming.set(agentId, msg)
    scheduleFlush()
    return
  }

  // Non-streaming assistant message finalizing a stream: flush pending first
  if (msg.type === 'assistant' && !msg.isStreaming) {
    pendingStreaming.delete(agentId)
    setState(agentId, prev => {
      const msgs = prev.messages
      const last = msgs[msgs.length - 1]
      if (last?.type === 'assistant' && last.isStreaming) {
        const updated = msgs.slice()
        updated[updated.length - 1] = msg
        return { ...prev, messages: updated }
      }
      return { ...prev, messages: trimMessages([...msgs, msg]) }
    })
    return
  }

  // All other message types: immediate update (truncate large tool inputs)
  const trimmed = msg.type === 'tool-use' ? truncateToolInput(msg) : msg
  setState(agentId, prev => ({ ...prev, messages: trimMessages([...prev.messages, trimmed]) }))
})

// Batch messages (session history) — single state update for the entire batch
api.onAgentMessageBatch((data: { agentId: string; messages: any[] }) => {
  if (!data?.agentId || !Array.isArray(data.messages)) return
  setState(data.agentId, prev => ({
    ...prev,
    messages: trimMessages([...prev.messages, ...data.messages]),
  }))
})

api.onPermissionRequest((data: any) => {
  if (!data?.agentId) return
  setState(data.agentId, prev => ({ ...prev, permissionRequest: data }))
})

api.onPermissionDismissed((data: { agentId: string; requestId: string }) => {
  if (!data?.agentId) return
  setState(data.agentId, prev => {
    // Only clear if the dismissed request matches the currently displayed one
    if (prev.permissionRequest?.requestId === data.requestId) {
      return {
        ...prev,
        permissionRequest: null,
        messages: trimMessages([...prev.messages, {
          id: Math.random().toString(36).slice(2, 10),
          type: 'system' as const,
          text: 'Permission request timed out — automatically denied.',
          ts: Date.now(),
        }]),
      }
    }
    return prev
  })
})

api.onSessionStarted((data: any) => {
  if (!data?.agentId) return
  setState(data.agentId, prev => ({ ...prev, isActive: true }))
})

api.onSessionEnded((data: any) => {
  if (!data?.agentId) return
  setState(data.agentId, prev => ({ ...prev, isActive: false }))
})

// ── Public: clear cache for a destroyed agent ──
export function clearAgentCache(agentId: string) {
  cache.delete(agentId)
  pendingStreaming.delete(agentId)
  notifyListeners()
}

// ── Hook ──

export function useAgent(agentId: string) {
  // Subscribe to the global cache via useSyncExternalStore
  const state = useSyncExternalStore(
    subscribe,
    () => getState(agentId),
  )

  const { messages, isActive, permissionRequest } = state

  const sendMessage = useCallback(async (text: string) => {
    // Add user message optimistically — main process no longer emits it back
    setState(agentId, prev => ({
      ...prev,
      messages: trimMessages([...prev.messages, {
        id: Math.random().toString(36).slice(2, 10),
        type: 'user' as const,
        text,
        ts: Date.now(),
      }]),
    }))
    await api.sendMessage(agentId, text)
  }, [agentId])

  const stopSession = useCallback(async () => {
    await api.stopAgent(agentId)
    setState(agentId, prev => ({ ...prev, isActive: false }))
  }, [agentId])

  const respondPermission = useCallback(async (behavior: 'allow' | 'deny', updatedInput?: Record<string, unknown>, alwaysAllow?: boolean) => {
    const pr = getState(agentId).permissionRequest
    if (!pr) return
    await api.respondPermission(agentId, {
      requestId: pr.requestId,
      behavior,
      updatedPermissions: behavior === 'allow' && alwaysAllow
        ? (pr.suggestions && pr.suggestions.length > 0 ? pr.suggestions : [{ tool: pr.toolName, allow: true }])
        : undefined,
      updatedInput,
    })
    setState(agentId, prev => ({ ...prev, permissionRequest: null }))
  }, [agentId])

  const clearMessages = useCallback(() => {
    setState(agentId, prev => ({ ...prev, messages: [] }))
    api.clearSession(agentId)
  }, [agentId])

  const resumeSession = useCallback(async (sessionId: string) => {
    await api.resumeSession(agentId, sessionId)
  }, [agentId])

  const continueSession = useCallback(async () => {
    await api.continueSession(agentId)
  }, [agentId])

  const clearPermission = useCallback(() => {
    setState(agentId, prev => ({ ...prev, permissionRequest: null }))
  }, [agentId])

  const addSystemMessage = useCallback((text: string) => {
    setState(agentId, prev => ({
      ...prev,
      messages: trimMessages([...prev.messages, {
        id: Math.random().toString(36).slice(2, 10),
        type: 'system' as const,
        text,
        ts: Date.now(),
      }]),
    }))
  }, [agentId])

  return {
    messages, isActive, permissionRequest,
    sendMessage, stopSession, respondPermission, clearPermission, clearMessages,
    resumeSession, continueSession, addSystemMessage,
  }
}
