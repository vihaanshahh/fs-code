import { useState, useEffect, useCallback, useRef } from 'react'
import { api } from '../lib/api'
import type { UIMessage, PermissionRequest } from '../../shared/types'

export function useAgent() {
  const [messages, setMessages] = useState<UIMessage[]>([])
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [isActive, setIsActive] = useState(false)
  const [permissionRequest, setPermissionRequest] = useState<PermissionRequest | null>(null)
  const cleanupRef = useRef<(() => void)[]>([])

  useEffect(() => {
    const unsubs: (() => void)[] = []

    unsubs.push(api.onAgentMessage((msg: UIMessage) => {
      setMessages(prev => {
        // If this is a streaming assistant message, replace the last streaming one
        if (msg.type === 'assistant' && msg.isStreaming) {
          const last = prev[prev.length - 1]
          if (last?.type === 'assistant' && last.isStreaming && last.id === msg.id) {
            return [...prev.slice(0, -1), msg]
          }
        }
        // If this is a finalized assistant message matching the last streaming one
        if (msg.type === 'assistant' && !msg.isStreaming) {
          const last = prev[prev.length - 1]
          if (last?.type === 'assistant' && last.isStreaming && last.id === msg.id) {
            return [...prev.slice(0, -1), msg]
          }
        }
        return [...prev, msg]
      })
    }))

    unsubs.push(api.onPermissionRequest((req: PermissionRequest) => {
      setPermissionRequest(req)
    }))

    unsubs.push(api.onSessionStarted((info: { sessionId: string }) => {
      setSessionId(info.sessionId)
      setIsActive(true)
    }))

    unsubs.push(api.onSessionEnded(() => {
      setIsActive(false)
    }))

    cleanupRef.current = unsubs
    return () => unsubs.forEach(fn => fn())
  }, [])

  const startSession = useCallback(async (cwd: string, model?: string) => {
    setMessages([])
    const { sessionId } = await api.startAgent(cwd, model)
    setSessionId(sessionId)
    setIsActive(true)
  }, [])

  const sendMessage = useCallback(async (text: string) => {
    await api.sendMessage(text)
  }, [])

  const stopSession = useCallback(async () => {
    await api.stopAgent()
    setIsActive(false)
  }, [])

  const respondPermission = useCallback(async (behavior: 'allow' | 'deny') => {
    if (!permissionRequest) return
    await api.respondPermission({
      requestId: permissionRequest.requestId,
      behavior,
      updatedPermissions: behavior === 'allow' ? permissionRequest.suggestions : undefined,
    })
    setPermissionRequest(null)
  }, [permissionRequest])

  return {
    messages,
    sessionId,
    isActive,
    permissionRequest,
    startSession,
    sendMessage,
    stopSession,
    respondPermission,
  }
}
