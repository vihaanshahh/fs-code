import React, { useState, useRef, useEffect } from 'react'
import type { UIMessage, PermissionRequest } from '../../../shared/types'

const TOOL_COLORS: Record<string, string> = {
  Bash: '#d29922', Read: '#58a6ff', Edit: '#3fb950', Write: '#3fb950',
  Grep: '#bc8cff', Glob: '#bc8cff', WebSearch: '#f778ba', Agent: '#f0883e',
}

function UserMsg({ msg }: { msg: Extract<UIMessage, { type: 'user' }> }) {
  return (
    <div style={{ padding: '10px 14px', background: '#161b22', borderRadius: 8, margin: '4px 8px', border: '1px solid #21262d' }}>
      <div style={{ fontSize: 11, color: '#8b949e', marginBottom: 4, fontWeight: 600 }}>You</div>
      <div style={{ fontSize: 13, color: '#e6edf3', whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{msg.text}</div>
    </div>
  )
}

function AssistantMsg({ msg }: { msg: Extract<UIMessage, { type: 'assistant' }> }) {
  return (
    <div style={{ padding: '10px 14px', margin: '4px 8px' }}>
      <div style={{ fontSize: 13, color: '#e6edf3', whiteSpace: 'pre-wrap', lineHeight: 1.6, wordBreak: 'break-word' }}>
        {msg.text}
        {msg.isStreaming && <span style={{ color: '#58a6ff', animation: 'pulse 1s infinite' }}>▊</span>}
      </div>
    </div>
  )
}

function ToolUseMsg({ msg }: { msg: Extract<UIMessage, { type: 'tool-use' }> }) {
  const [expanded, setExpanded] = useState(false)
  const color = TOOL_COLORS[msg.toolName] || '#8b949e'
  const inputStr = typeof msg.input === 'string' ? msg.input : JSON.stringify(msg.input, null, 2)
  const preview = inputStr.split('\n')[0].slice(0, 80)

  return (
    <div style={{
      margin: '4px 8px', border: '1px solid #21262d', borderRadius: 6,
      borderLeft: `3px solid ${color}`, overflow: 'hidden',
    }}>
      <div
        style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px',
          cursor: 'pointer', fontSize: 12,
        }}
        onClick={() => setExpanded(!expanded)}
      >
        <span style={{
          background: color + '20', color, borderRadius: 3, padding: '1px 6px',
          fontSize: 11, fontWeight: 700, fontFamily: 'monospace',
        }}>{msg.toolName}</span>
        <span style={{ color: '#484f58', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {preview}
        </span>
        <span style={{ color: '#484f58', fontSize: 10 }}>{expanded ? '▼' : '▶'}</span>
      </div>
      {expanded && (
        <pre style={{
          padding: '8px 10px', margin: 0, fontSize: 11, color: '#8b949e',
          background: '#010409', borderTop: '1px solid #21262d',
          overflow: 'auto', maxHeight: 300, whiteSpace: 'pre-wrap', wordBreak: 'break-all',
        }}>{inputStr}</pre>
      )}
    </div>
  )
}

function SystemMsg({ msg }: { msg: Extract<UIMessage, { type: 'system' }> }) {
  return (
    <div style={{ padding: '3px 14px', fontSize: 11, color: '#6e7681', fontStyle: 'italic', margin: '2px 8px' }}>
      {msg.text}
    </div>
  )
}

function ErrorMsg({ msg }: { msg: Extract<UIMessage, { type: 'error' }> }) {
  return (
    <div style={{
      padding: '8px 14px', margin: '4px 8px', fontSize: 12, color: '#ff7b72',
      background: '#ff7b7210', border: '1px solid #ff7b7230', borderRadius: 6,
    }}>{msg.message}</div>
  )
}

function ResultMsg({ msg }: { msg: Extract<UIMessage, { type: 'result' }> }) {
  return (
    <div style={{
      padding: '6px 14px', margin: '4px 8px', fontSize: 11, color: '#8b949e',
      background: '#161b22', borderRadius: 6, display: 'flex', gap: 16,
    }}>
      <span>Done in {(msg.duration / 1000).toFixed(1)}s</span>
      <span>{msg.numTurns} turn{msg.numTurns !== 1 ? 's' : ''}</span>
      <span>${msg.cost.toFixed(4)}</span>
    </div>
  )
}

function PermissionModal({
  request, onRespond,
}: {
  request: PermissionRequest
  onRespond: (behavior: 'allow' | 'deny') => void
}) {
  const inputStr = JSON.stringify(request.input, null, 2)
  return (
    <div style={{
      position: 'absolute', bottom: 60, left: 8, right: 8, zIndex: 100,
      background: '#161b22', border: '1px solid #d29922', borderRadius: 8,
      padding: 16, boxShadow: '0 8px 32px #01040980',
    }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: '#d29922', marginBottom: 8 }}>
        Permission Required: {request.toolName}
      </div>
      {request.decisionReason && (
        <div style={{ fontSize: 12, color: '#8b949e', marginBottom: 8 }}>{request.decisionReason}</div>
      )}
      <pre style={{
        fontSize: 11, color: '#8b949e', background: '#010409', borderRadius: 4,
        padding: 8, maxHeight: 150, overflow: 'auto', marginBottom: 12,
        whiteSpace: 'pre-wrap', wordBreak: 'break-all',
      }}>{inputStr}</pre>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button
          onClick={() => onRespond('deny')}
          style={{
            background: '#21262d', color: '#ff7b72', border: '1px solid #30363d',
            borderRadius: 6, padding: '6px 16px', fontSize: 12, cursor: 'pointer',
          }}
        >Deny</button>
        <button
          onClick={() => onRespond('allow')}
          style={{
            background: '#238636', color: '#fff', border: 'none',
            borderRadius: 6, padding: '6px 16px', fontSize: 12, cursor: 'pointer',
          }}
        >Allow</button>
      </div>
    </div>
  )
}

export default function ChatPanel({
  messages, isActive, permissionRequest,
  onSendMessage, onStop, onStart, onRespondPermission,
}: {
  messages: UIMessage[]
  isActive: boolean
  permissionRequest: PermissionRequest | null
  onSendMessage: (text: string) => void
  onStop: () => void
  onStart: (cwd: string) => void
  onRespondPermission: (behavior: 'allow' | 'deny') => void
}) {
  const [input, setInput] = useState('')
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length, messages[messages.length - 1]])

  const handleSubmit = () => {
    const text = input.trim()
    if (!text) return
    if (!isActive) {
      // Start a new session with the first message
      onStart(process.cwd?.() || '.')
      setTimeout(() => onSendMessage(text), 500)
    } else {
      onSendMessage(text)
    }
    setInput('')
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: '#0d1117', position: 'relative' }}>
      {/* Header */}
      <div style={{
        padding: '10px 14px', borderBottom: '1px solid #21262d',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <span style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', color: '#8b949e', letterSpacing: 1 }}>
          Agent
        </span>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {isActive && (
            <>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#3fb950', animation: 'pulse 2s infinite' }} />
              <button
                onClick={onStop}
                style={{
                  background: '#21262d', color: '#ff7b72', border: '1px solid #30363d',
                  borderRadius: 4, padding: '2px 8px', fontSize: 11, cursor: 'pointer',
                }}
              >Stop</button>
            </>
          )}
        </div>
      </div>

      {/* Messages */}
      <div style={{ flex: 1, overflow: 'auto', paddingBottom: 8 }}>
        {messages.length === 0 ? (
          <div style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center',
            justifyContent: 'center', height: '100%', color: '#484f58', gap: 8,
          }}>
            <span style={{ fontSize: 24, opacity: 0.4 }}>⚡</span>
            <span style={{ fontSize: 12 }}>Start a conversation</span>
          </div>
        ) : (
          messages.map((msg) => {
            switch (msg.type) {
              case 'user': return <UserMsg key={msg.id} msg={msg} />
              case 'assistant': return <AssistantMsg key={msg.id} msg={msg} />
              case 'tool-use': return <ToolUseMsg key={msg.id} msg={msg} />
              case 'system': return <SystemMsg key={msg.id} msg={msg} />
              case 'error': return <ErrorMsg key={msg.id} msg={msg} />
              case 'result': return <ResultMsg key={msg.id} msg={msg} />
              default: return null
            }
          })
        )}
        <div ref={endRef} />
      </div>

      {/* Permission modal */}
      {permissionRequest && (
        <PermissionModal request={permissionRequest} onRespond={onRespondPermission} />
      )}

      {/* Input */}
      <div style={{ borderTop: '1px solid #21262d', padding: 8 }}>
        <div style={{ display: 'flex', gap: 6 }}>
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder={isActive ? 'Send a message...' : 'Type a prompt to start...'}
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
          <button
            onClick={handleSubmit}
            disabled={!input.trim()}
            style={{
              background: input.trim() ? '#238636' : '#21262d',
              color: input.trim() ? '#fff' : '#484f58',
              border: 'none', borderRadius: 6,
              padding: '0 14px', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit',
            }}
          >↑</button>
        </div>
      </div>
    </div>
  )
}
