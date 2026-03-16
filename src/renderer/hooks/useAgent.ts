import { useState, useEffect, useCallback, useSyncExternalStore } from 'react'
import { api } from '../lib/api'
import type { UIMessage, PermissionRequest } from '../../shared/types'

// ── Global message cache ──
// Messages persist here across component mount/unmount cycles (e.g. pill mode).
// IPC listeners run once at module load — they never tear down.

interface AgentState {
  messages: UIMessage[]
  isActive: boolean
  permissionRequest: PermissionRequest | null
}

const cache = new Map<string, AgentState>()
const listeners = new Set<() => void>()

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
    listeners.forEach(fn => fn())
  }
}

function subscribe(cb: () => void) {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

// ── Always-on IPC listeners (registered once at module load) ──

api.onAgentMessage((data: any) => {
  const agentId = data.agentId as string
  const msg: UIMessage = data
  setState(agentId, prev => {
    const msgs = prev.messages
    if (msg.type === 'assistant' && msg.isStreaming) {
      const last = msgs[msgs.length - 1]
      if (last?.type === 'assistant' && last.isStreaming) {
        return { ...prev, messages: [...msgs.slice(0, -1), msg] }
      }
    }
    if (msg.type === 'assistant' && !msg.isStreaming) {
      const last = msgs[msgs.length - 1]
      if (last?.type === 'assistant' && last.isStreaming) {
        return { ...prev, messages: [...msgs.slice(0, -1), msg] }
      }
    }
    return { ...prev, messages: [...msgs, msg] }
  })
})

api.onPermissionRequest((data: any) => {
  setState(data.agentId, prev => ({ ...prev, permissionRequest: data }))
})

api.onPermissionDismissed((data: { agentId: string; requestId: string }) => {
  setState(data.agentId, prev => {
    // Only clear if the dismissed request matches the currently displayed one
    if (prev.permissionRequest?.requestId === data.requestId) {
      return {
        ...prev,
        permissionRequest: null,
        messages: [...prev.messages, {
          id: Math.random().toString(36).slice(2, 10),
          type: 'system' as const,
          text: 'Permission request timed out — automatically denied.',
          ts: Date.now(),
        }],
      }
    }
    return prev
  })
})

api.onSessionStarted((data: any) => {
  setState(data.agentId, prev => ({ ...prev, isActive: true }))
})

api.onSessionEnded((data: any) => {
  setState(data.agentId, prev => ({ ...prev, isActive: false }))
})

// ── Public: clear cache for a destroyed agent ──
export function clearAgentCache(agentId: string) {
  cache.delete(agentId)
  listeners.forEach(fn => fn())
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
      messages: [...prev.messages, {
        id: Math.random().toString(36).slice(2, 10),
        type: 'user' as const,
        text,
        ts: Date.now(),
      }],
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
      updatedPermissions: behavior === 'allow' && alwaysAllow ? pr.suggestions : undefined,
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
      messages: [...prev.messages, {
        id: Math.random().toString(36).slice(2, 10),
        type: 'system' as const,
        text,
        ts: Date.now(),
      }],
    }))
  }, [agentId])

  return {
    messages, isActive, permissionRequest,
    sendMessage, stopSession, respondPermission, clearPermission, clearMessages,
    resumeSession, continueSession, addSystemMessage,
  }
}
