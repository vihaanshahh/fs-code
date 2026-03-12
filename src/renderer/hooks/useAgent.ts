import { useState, useEffect, useCallback, useRef } from 'react'
import { api } from '../lib/api'
import type { UIMessage, PermissionRequest } from '../../shared/types'

export function useAgent() {
  const [messages, setMessages] = useState<UIMessage[]>([])
  const [isActive, setIsActive] = useState(false)
  const [permissionRequest, setPermissionRequest] = useState<PermissionRequest | null>(null)

  useEffect(() => {
    const unsubs: (() => void)[] = []

    unsubs.push(api.onAgentMessage((msg: UIMessage) => {
      setMessages(prev => {
        // Replace streaming assistant messages in-place
        if (msg.type === 'assistant' && msg.isStreaming) {
          const last = prev[prev.length - 1]
          if (last?.type === 'assistant' && last.isStreaming) {
            return [...prev.slice(0, -1), msg]
          }
        }
        if (msg.type === 'assistant' && !msg.isStreaming) {
          const last = prev[prev.length - 1]
          if (last?.type === 'assistant' && last.isStreaming) {
            return [...prev.slice(0, -1), msg]
          }
        }
        return [...prev, msg]
      })
    }))

    unsubs.push(api.onPermissionRequest((req: PermissionRequest) => {
      setPermissionRequest(req)
    }))

    unsubs.push(api.onSessionStarted(() => setIsActive(true)))
    unsubs.push(api.onSessionEnded(() => setIsActive(false)))

    return () => unsubs.forEach(fn => fn())
  }, [])

  // Send a message — auto-starts a new session each time
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

  const clearMessages = useCallback(() => setMessages([]), [])

  return { messages, isActive, permissionRequest, sendMessage, stopSession, respondPermission, clearMessages }
}
