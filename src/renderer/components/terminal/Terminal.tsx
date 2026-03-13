import React, { useEffect, useRef, useState, useCallback } from 'react'
import { api } from '../../lib/api'
import { useTheme } from '../../ThemeContext'

export default function TerminalPanel({ cwd }: { cwd: string }) {
  const { colors, fonts } = useTheme()
  const shortCwd = cwd === '.' ? '~' : '~/' + cwd.split('/').slice(-2).join('/')
  const [lines, setLines] = useState<Array<{ text: string; type: 'output' | 'input' | 'dim' }>>([
    { text: `${shortCwd}`, type: 'dim' },
  ])
  const [terminalId, setTerminalId] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [history, setHistory] = useState<string[]>([])
  const [historyIdx, setHistoryIdx] = useState(-1)
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
    setHistory(prev => [...prev, cmd])
    setHistoryIdx(-1)
    setInput('')
  }, [terminalId])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleCommand(input)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (history.length === 0) return
      const idx = historyIdx === -1 ? history.length - 1 : Math.max(0, historyIdx - 1)
      setHistoryIdx(idx)
      setInput(history[idx])
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (historyIdx === -1) return
      if (historyIdx >= history.length - 1) {
        setHistoryIdx(-1)
        setInput('')
      } else {
        const idx = historyIdx + 1
        setHistoryIdx(idx)
        setInput(history[idx])
      }
    } else if (e.key === 'l' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      setLines([{ text: shortCwd, type: 'dim' }])
    }
  }, [input, handleCommand, history, historyIdx, shortCwd])

  return (
    <div
      style={{
        height: '100%', display: 'flex', flexDirection: 'column', background: colors.bgOverlay,
        fontFamily: fonts.mono, fontSize: 13,
      }}
      onClick={() => inputRef.current?.focus()}
    >
      <div ref={containerRef} style={{ flex: 1, overflow: 'auto', padding: 8 }}>
        {lines.map((line, i) => (
          <div key={i} style={{
            lineHeight: 1.5, whiteSpace: 'pre-wrap',
            color: line.type === 'input' ? colors.green : line.type === 'dim' ? colors.textMuted : colors.text,
            fontSize: line.type === 'dim' ? 11 : undefined,
          }}>
            {line.text}
          </div>
        ))}
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <span style={{ color: colors.blue, fontSize: 11, marginRight: 6 }}>{shortCwd}</span>
          <span style={{ color: colors.green }}>$ </span>
          <input
            ref={inputRef}
            style={{
              background: 'transparent', border: 'none', color: colors.text, outline: 'none',
              fontFamily: 'inherit', fontSize: 'inherit', width: '100%', caretColor: colors.blue,
            }}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            spellCheck={false}
          />
        </div>
      </div>
    </div>
  )
}
