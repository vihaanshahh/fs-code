import { useCallback, useSyncExternalStore } from 'react'
import { api } from '../lib/api'
import type { UIMessage } from '../../shared/types'

// ── Global agent state cache ──
// Tracks active state per agent. Messages/permissions are now handled
// natively by the claude CLI running in the terminal.

interface AgentState {
  messages: UIMessage[]
  isActive: boolean
}

const cache = new Map<string, AgentState>()
const listeners = new Set<() => void>()

function notifyListeners() {
  listeners.forEach(fn => fn())
}

function getState(agentId: string): AgentState {
  let s = cache.get(agentId)
  if (!s) {
    s = { messages: [], isActive: false }
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

function subscribe(cb: () => void) {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

// ── IPC listeners — keep session tracking for active dot indicator ──

api.onSessionStarted((data: any) => {
  if (!data?.agentId) return
  setState(data.agentId, prev => ({ ...prev, isActive: true }))
})

api.onSessionEnded((data: any) => {
  if (!data?.agentId) return
  setState(data.agentId, prev => ({ ...prev, isActive: false }))
})

// Keep message listener for JourneyBar / FileActivity compatibility
api.onAgentMessage((data: any) => {
  const agentId = data.agentId as string
  if (!agentId) return
  const msg: UIMessage = data
  setState(agentId, prev => ({
    ...prev,
    messages: [...prev.messages.slice(-199), msg],
  }))
})

api.onAgentMessageBatch((data: { agentId: string; messages: any[] }) => {
  if (!data?.agentId || !Array.isArray(data.messages)) return
  setState(data.agentId, prev => ({
    ...prev,
    messages: [...prev.messages, ...data.messages].slice(-200),
  }))
})

// ── Public: clear cache for a destroyed agent ──
export function clearAgentCache(agentId: string) {
  cache.delete(agentId)
  notifyListeners()
}

// ── Hook ──

export function useAgent(agentId: string) {
  const state = useSyncExternalStore(
    subscribe,
    () => getState(agentId),
  )

  const { messages, isActive } = state

  const sendMessage = useCallback(async (text: string) => {
    await api.sendMessage(agentId, text)
  }, [agentId])

  const stopSession = useCallback(async () => {
    await api.stopAgent(agentId)
    setState(agentId, prev => ({ ...prev, isActive: false }))
  }, [agentId])

  const clearMessages = useCallback(() => {
    setState(agentId, prev => ({ ...prev, messages: [] }))
    api.clearSession(agentId)
  }, [agentId])

  return {
    messages, isActive,
    sendMessage, stopSession, clearMessages,
  }
}
