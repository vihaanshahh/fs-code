import React, { useEffect, useRef, useState, useCallback } from 'react'
import { api } from '../../lib/api'

export default function TerminalPanel({ cwd }: { cwd: string }) {
  const [lines, setLines] = useState<Array<{ text: string; type: 'output' | 'input' }>>([
    { text: 'FS Code Terminal', type: 'output' },
  ])
  const [terminalId, setTerminalId] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Create terminal on mount
  useEffect(() => {
    let id: string | null = null
    api.createTerminal(cwd).then(({ terminalId }) => {
      id = terminalId
      setTerminalId(terminalId)
    })

    const unsub = api.onTerminalData(({ terminalId: tid, data }) => {
      if (tid === id) {
        setLines(prev => [...prev, { text: data, type: 'output' }])
      }
    })

    return () => {
      unsub()
      if (id) api.closeTerminal(id)
    }
  }, [cwd])

  // Auto-scroll
  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight
    }
  }, [lines.length])

  const handleCommand = useCallback((cmd: string) => {
    if (!terminalId || !cmd.trim()) return
    setLines(prev => [...prev, { text: `$ ${cmd}`, type: 'input' }])
    api.writeTerminal(terminalId, cmd + '\n')
    setInput('')
  }, [terminalId])

  return (
    <div
      style={{
        height: '100%', display: 'flex', flexDirection: 'column', background: '#0d1117',
        fontFamily: "'SF Mono', 'Fira Code', monospace", fontSize: 13,
      }}
      onClick={() => inputRef.current?.focus()}
    >
      <div ref={containerRef} style={{ flex: 1, overflow: 'auto', padding: 8 }}>
        {lines.map((line, i) => (
          <div key={i} style={{
            lineHeight: 1.5, whiteSpace: 'pre-wrap',
            color: line.type === 'input' ? '#3fb950' : '#e6edf3',
          }}>
            {line.text}
          </div>
        ))}
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <span style={{ color: '#3fb950' }}>$ </span>
          <input
            ref={inputRef}
            style={{
              background: 'transparent', border: 'none', color: '#e6edf3', outline: 'none',
              fontFamily: 'inherit', fontSize: 'inherit', width: '100%', caretColor: '#58a6ff',
            }}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') handleCommand(input)
            }}
            spellCheck={false}
          />
        </div>
      </div>
    </div>
  )
}
