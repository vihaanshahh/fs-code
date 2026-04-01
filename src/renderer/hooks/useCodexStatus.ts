import { useState, useEffect } from 'react'
import type { CodexStatus, CodexStatusState } from '../../shared/types'
import { api } from '../lib/api'

// Cache so status survives re-mounts within the same session
const statusCache = new Map<string, CodexStatus>()

interface CodexStatusEvent {
  agentId: string
  state: CodexStatusState
  filesProcessed?: number
  totalFiles?: number
  symbols?: number
  error?: string
}

export function useCodexStatus(agentId: string | null): CodexStatus | null {
  const [status, setStatus] = useState<CodexStatus | null>(
    agentId ? (statusCache.get(agentId) ?? null) : null
  )

  useEffect(() => {
    if (!agentId) { setStatus(null); return }
    setStatus(statusCache.get(agentId) ?? null)

    return api.onCodexStatus((data: CodexStatusEvent) => {
      if (data.agentId !== agentId) return
      const s: CodexStatus = {
        state: data.state,
        filesProcessed: data.filesProcessed,
        totalFiles: data.totalFiles,
        symbols: data.symbols,
        error: data.error,
      }
      statusCache.set(agentId, s)
      setStatus(s)
    })
  }, [agentId])

  return status
}
