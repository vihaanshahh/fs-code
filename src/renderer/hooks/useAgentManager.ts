import { useState, useCallback, useEffect, useRef } from 'react'
import { api } from '../lib/api'
import { clearAgentCache } from './useAgent'
import { addRecentFolder } from './useRecentFolders'
import type { AgentDescriptor, ProviderId } from '../../shared/types'

const MAX_AGENTS = 9
const AGENT_NAMES = [
  'Agent 1', 'Agent 2', 'Agent 3',
  'Agent 4', 'Agent 5', 'Agent 6',
  'Agent 7', 'Agent 8', 'Agent 9',
]
const SESSION_KEY = 'fs-code-session'
const SESSION_MAX_AGE = 24 * 60 * 60 * 1000 // 24h

type SavedSession = {
  agents: { name: string; cwd: string; provider?: ProviderId }[]
  focusedIndex: number
  savedAt: number
}

function loadSession(): SavedSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as SavedSession
    if (!parsed.agents?.length) return null
    if (Date.now() - parsed.savedAt > SESSION_MAX_AGE) return null
    return parsed
  } catch {
    return null
  }
}

export function saveSession(agents: AgentDescriptor[], focusedId: string | null): void {
  if (!agents.length) {
    localStorage.removeItem(SESSION_KEY)
    return
  }
  const focusedIndex = focusedId ? agents.findIndex(a => a.id === focusedId) : 0
  const data: SavedSession = {
    agents: agents.map(a => ({ name: a.name, cwd: a.cwd, provider: a.provider })),
    focusedIndex: Math.max(0, focusedIndex),
    savedAt: Date.now(),
  }
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(data))
  } catch { /* ignore */ }
}

export function useAgentManager() {
  const [agents, setAgents] = useState<AgentDescriptor[]>([])
  const [focusedId, setFocusedId] = useState<string | null>(null)
  // Ref tracks agents synchronously so async callbacks see current count
  const agentsRef = useRef<AgentDescriptor[]>([])
  agentsRef.current = agents
  const restoredRef = useRef(false)

  // Low-level create: takes a resolved cwd + optional provider, calls main process, updates state
  const doCreateAgent = useCallback(async (cwd: string, provider?: ProviderId): Promise<AgentDescriptor | null> => {
    if (agentsRef.current.length >= MAX_AGENTS) return null
    const name = AGENT_NAMES[agentsRef.current.length] || `Agent ${agentsRef.current.length + 1}`
    const descriptor: AgentDescriptor = await api.createAgent(name, cwd, provider)
    if (!descriptor?.id) return null
    setAgents(prev => [...prev, descriptor])
    setFocusedId(descriptor.id)
    addRecentFolder(cwd)
    return descriptor
  }, [])

  // Always pick a folder for new agents
  const pickAndCreate = useCallback(async (provider?: ProviderId): Promise<AgentDescriptor | null> => {
    if (agentsRef.current.length >= MAX_AGENTS) return null
    const folder = await api.openFolderDialog()
    if (!folder) return null
    return doCreateAgent(folder, provider)
  }, [doCreateAgent])

  // Create agent — if cwd given, use it directly; otherwise open folder picker
  const createAgent = useCallback(async (cwd?: string, provider?: ProviderId): Promise<AgentDescriptor | null> => {
    if (agentsRef.current.length >= MAX_AGENTS) return null
    if (cwd) return doCreateAgent(cwd, provider)
    return pickAndCreate(provider)
  }, [doCreateAgent, pickAndCreate])

  // Restore previous session on mount (once)
  useEffect(() => {
    if (restoredRef.current) return
    restoredRef.current = true
    const session = loadSession()
    if (!session) return
    // Clear saved session immediately to prevent crash loops
    localStorage.removeItem(SESSION_KEY)
    ;(async () => {
      const created: AgentDescriptor[] = []
      for (const saved of session.agents) {
        if (created.length >= MAX_AGENTS) break
        try {
          const desc = await api.createAgent(
            saved.name,
            saved.cwd,
            saved.provider,
          )
          created.push(desc)
          addRecentFolder(saved.cwd)
        } catch { /* folder may no longer exist */ }
      }
      if (created.length) {
        setAgents(created)
        const idx = Math.min(session.focusedIndex, created.length - 1)
        setFocusedId(created[idx].id)
      }
    })()
  }, [])

  const closeAgent = useCallback(async (agentId: string) => {
    await api.closeAgent(agentId)
    clearAgentCache(agentId)
    const remaining = agentsRef.current.filter(a => a.id !== agentId)
    setAgents(remaining)
    if (focusedId === agentId) {
      setFocusedId(remaining.length > 0 ? remaining[0].id : null)
    }
  }, [focusedId])

  const focusAgent = useCallback((agentId: string) => {
    setFocusedId(agentId)
  }, [])

  const focusByIndex = useCallback((index: number) => {
    const list = agentsRef.current
    if (index >= 0 && index < list.length) {
      setFocusedId(list[index].id)
    }
  }, [])

  const renameAgent = useCallback((agentId: string, newName: string) => {
    const name = newName.trim().slice(0, 8)
    if (!name) return
    setAgents(prev => prev.map(a => a.id === agentId ? { ...a, name } : a))
    // Sync rename to main process so it persists there too
    api.renameAgent(agentId, name)
  }, [])

  const reorderAgents = useCallback((fromIndex: number, toIndex: number) => {
    setAgents(prev => {
      if (fromIndex < 0 || fromIndex >= prev.length) return prev
      if (toIndex < 0 || toIndex >= prev.length) return prev
      if (fromIndex === toIndex) return prev
      const next = [...prev]
      const [moved] = next.splice(fromIndex, 1)
      next.splice(toIndex, 0, moved)
      return next
    })
  }, [])

  // Auto-save session whenever agents or focus changes (debounced)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!agents.length) return
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      saveSession(agents, focusedId)
    }, 500)
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    }
  }, [agents, focusedId])

  const focusedAgent = agents.find(a => a.id === focusedId) || agents[0] || null

  return {
    agents,
    focusedId: focusedAgent?.id || null,
    focusedAgent,
    createAgent,
    closeAgent,
    focusAgent,
    focusByIndex,
    renameAgent,
    reorderAgents,
    canAddAgent: agents.length < MAX_AGENTS,
  }
}
