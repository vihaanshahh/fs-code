import React, { useState, useRef, useEffect } from 'react'
import type { UIMessage, PermissionRequest } from '../../../shared/types'

function Message({ msg }: { msg: UIMessage }) {
  const [expanded, setExpanded] = useState(false)

  switch (msg.type) {
    case 'user':
      return (
        <div style={{ padding: '8px 12px', margin: '4px 0', background: '#f6f8fa10', borderRadius: 6 }}>
          <div style={{ fontSize: 13, color: '#c9d1d9', whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{msg.text}</div>
        </div>
      )

    case 'assistant':
      return (
        <div style={{ padding: '8px 12px', margin: '4px 0' }}>
          <div style={{ fontSize: 13, color: '#e6edf3', whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>
            {msg.text}
            {msg.isStreaming && <span style={{ color: '#58a6ff', animation: 'pulse 1s infinite' }}>|</span>}
          </div>
        </div>
      )

    case 'tool-use': {
      const inputStr = typeof msg.input === 'string' ? msg.input : JSON.stringify(msg.input, null, 2)
      return (
        <div
          style={{ margin: '2px 0', borderLeft: '2px solid #30363d', cursor: 'pointer' }}
          onClick={() => setExpanded(!expanded)}
        >
          <div style={{ padding: '4px 10px', fontSize: 12, color: '#8b949e', display: 'flex', gap: 6 }}>
            <span style={{ color: '#58a6ff', fontWeight: 600, fontFamily: 'monospace' }}>{msg.toolName}</span>
            {!expanded && <span style={{ opacity: 0.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{inputStr.split('\n')[0].slice(0, 60)}</span>}
          </div>
          {expanded && (
            <pre style={{ padding: '4px 10px', margin: 0, fontSize: 11, color: '#6e7681', whiteSpace: 'pre-wrap', maxHeight: 200, overflow: 'auto' }}>{inputStr}</pre>
          )}
        </div>
      )
    }

    case 'system':
      return <div style={{ padding: '2px 12px', fontSize: 11, color: '#484f58' }}>{msg.text}</div>

    case 'error':
      return <div style={{ padding: '6px 12px', margin: '4px 0', fontSize: 12, color: '#f85149' }}>{msg.message}</div>

    case 'result':
      return (
        <div style={{ padding: '4px 12px', margin: '4px 0', fontSize: 11, color: '#484f58', display: 'flex', gap: 12 }}>
          <span>{(msg.duration / 1000).toFixed(1)}s</span>
          <span>{msg.numTurns} turns</span>
          <span>${msg.cost.toFixed(4)}</span>
        </div>
      )

    default:
      return null
  }
}

export default function ChatPanel({
  messages, isActive, permissionRequest, onSend, onStop, onRespondPermission,
}: {
  messages: UIMessage[]
  isActive: boolean
  permissionRequest: PermissionRequest | null
  onSend: (text: string) => void
  onStop: () => void
  onRespondPermission: (behavior: 'allow' | 'deny') => void
}) {
  const [input, setInput] = useState('')
  const endRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length, messages[messages.length - 1]])

  // Auto-focus input
  useEffect(() => { inputRef.current?.focus() }, [])

  const handleSubmit = () => {
    const text = input.trim()
    if (!text) return
    onSend(text)
    setInput('')
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: '#0d1117' }}>
      {/* Messages */}
      <div style={{ flex: 1, overflow: 'auto', padding: '8px 8px 0' }}>
        {messages.length === 0 && (
          <div style={{ textAlign: 'center', padding: '40px 20px', color: '#30363d', fontSize: 13 }}>
            Type a message to start
          </div>
        )}
        {messages.map(msg => <Message key={msg.id} msg={msg} />)}
        <div ref={endRef} />
      </div>

      {/* Permission prompt */}
      {permissionRequest && (
        <div style={{
          margin: 8, padding: 12, background: '#161b22', border: '1px solid #d29922',
          borderRadius: 6, fontSize: 12,
        }}>
          <div style={{ color: '#d29922', fontWeight: 600, marginBottom: 6 }}>
            Allow {permissionRequest.toolName}?
          </div>
          <pre style={{
            fontSize: 11, color: '#8b949e', background: '#0d1117', borderRadius: 4,
            padding: 6, maxHeight: 100, overflow: 'auto', margin: '0 0 8px', whiteSpace: 'pre-wrap',
          }}>{JSON.stringify(permissionRequest.input, null, 2)}</pre>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={() => onRespondPermission('deny')} style={{ background: 'none', border: '1px solid #30363d', color: '#8b949e', borderRadius: 4, padding: '4px 12px', fontSize: 12, cursor: 'pointer' }}>Deny</button>
            <button onClick={() => onRespondPermission('allow')} style={{ background: '#238636', border: 'none', color: '#fff', borderRadius: 4, padding: '4px 12px', fontSize: 12, cursor: 'pointer' }}>Allow</button>
          </div>
        </div>
      )}

      {/* Input */}
      <div style={{ padding: 8, borderTop: '1px solid #21262d' }}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end' }}>
          <textarea
            ref={inputRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder="Message Claude..."
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                handleSubmit()
              }
            }}
            style={{
              flex: 1, background: '#161b22', border: '1px solid #21262d', borderRadius: 6,
              color: '#e6edf3', padding: '8px 10px', fontSize: 13, fontFamily: 'inherit',
              resize: 'none', outline: 'none', minHeight: 36, maxHeight: 120,
            }}
            rows={1}
          />
          {isActive && (
            <button onClick={onStop} style={{
              background: 'none', border: '1px solid #30363d', color: '#f85149',
              borderRadius: 6, padding: '8px 10px', fontSize: 12, cursor: 'pointer',
            }}>Stop</button>
          )}
        </div>
      </div>
    </div>
  )
}
