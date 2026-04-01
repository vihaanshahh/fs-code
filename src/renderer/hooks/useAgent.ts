import { useCallback, useSyncExternalStore } from 'react'
import { api } from '../lib/api'
import type { UIMessage, AgentPhaseSnapshot } from '../../shared/types'

// ── Global agent state cache ──
// Tracks active state per agent. Messages/permissions are now handled
// natively by the claude CLI running in the terminal.

interface AgentState {
  messages: UIMessage[]
  isActive: boolean
  phaseSnapshot: AgentPhaseSnapshot | null
}

const cache = new Map<string, AgentState>()
const listeners = new Set<() => void>()

function notifyListeners() {
  listeners.forEach(fn => fn())
}

function getState(agentId: string): AgentState {
  let s = cache.get(agentId)
  if (!s) {
    s = { messages: [], isActive: false, phaseSnapshot: null }
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

export function setAgentPhaseSnapshot(agentId: string, phaseSnapshot: AgentPhaseSnapshot | null) {
  setState(agentId, prev => {
    const current = prev.phaseSnapshot
    if (
      current?.phase === phaseSnapshot?.phase
      && current?.detail === phaseSnapshot?.detail
      && current?.startedAt === phaseSnapshot?.startedAt
      && current?.activeTool?.toolUseId === phaseSnapshot?.activeTool?.toolUseId
    ) {
      return prev
    }
    return { ...prev, phaseSnapshot }
  })
}

export function clearAgentAwaitingSnapshot(agentId: string) {
  setState(agentId, prev => (
    prev.phaseSnapshot?.phase === 'awaiting' || prev.phaseSnapshot?.phase === 'idle'
      ? { ...prev, phaseSnapshot: null }
      : prev
  ))
}

// ── IPC listeners — keep session tracking for active dot indicator ──
// Guard against duplicate registration on hot-reload: store cleanup fns
// and call them before re-registering.

let _ipcCleanups: (() => void)[] | null = null

function setupIpcListeners() {
  // Clean up any previous listeners (hot-reload safety)
  if (_ipcCleanups) {
    _ipcCleanups.forEach(fn => fn())
  }

  const cleanups: (() => void)[] = []

  cleanups.push(api.onSessionStarted((data: any) => {
    if (!data?.agentId) return
    setState(data.agentId, prev => ({
      ...prev,
      isActive: true,
      phaseSnapshot: null,
    }))
  }))

  cleanups.push(api.onSessionEnded((data: any) => {
    if (!data?.agentId) return
    setState(data.agentId, prev => ({
      ...prev,
      isActive: false,
      phaseSnapshot: prev.phaseSnapshot?.phase === 'done' ? prev.phaseSnapshot : null,
    }))
  }))

  // Keep message listener for JourneyBar / FileActivity compatibility
  cleanups.push(api.onAgentMessage((data: any) => {
    const agentId = data.agentId as string
    if (!agentId || !data.type || !data.id) return
    const msg: UIMessage = data
    setState(agentId, prev => ({
      ...prev,
      messages: [...prev.messages.slice(-199), msg],
    }))
  }))

  cleanups.push(api.onAgentPhase((data: any) => {
    const agentId = data.agentId as string
    if (!agentId || !data.phase) return
    setState(agentId, prev => ({
      ...prev,
      phaseSnapshot: {
        phase: data.phase,
        detail: data.detail || '',
        startedAt: data.startedAt || Date.now(),
        activeTool: data.activeTool,
      },
    }))
  }))

  cleanups.push(api.onAgentMessageBatch((data: { agentId: string; messages: any[] }) => {
    if (!data?.agentId || !Array.isArray(data.messages)) return
    setState(data.agentId, prev => ({
      ...prev,
      messages: [...prev.messages, ...data.messages].slice(-200),
    }))
  }))

  _ipcCleanups = cleanups
}

setupIpcListeners()

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
  const { phaseSnapshot } = state

  const sendMessage = useCallback(async (text: string) => {
    await api.sendMessage(agentId, text)
  }, [agentId])

  const stopSession = useCallback(async () => {
    await api.stopAgent(agentId)
    setState(agentId, prev => ({ ...prev, isActive: false, phaseSnapshot: null }))
  }, [agentId])

  const clearMessages = useCallback(() => {
    setState(agentId, prev => ({ ...prev, messages: [], phaseSnapshot: null }))
    api.clearSession(agentId)
  }, [agentId])

  return {
    messages, isActive, phaseSnapshot,
    sendMessage, stopSession, clearMessages,
  }
}
