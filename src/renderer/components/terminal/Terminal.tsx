import React, { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { api } from '../../lib/api'
import { useTheme } from '../../ThemeContext'

export default function TerminalPanel({
  agentId,
  cwd,
  mode = 'shell',
  resume,
}: {
  agentId: string
  cwd: string
  /** 'claude' launches `claude` CLI in the terminal; 'shell' is a plain shell */
  mode?: 'shell' | 'claude'
  /** Session ID to resume (only used in claude mode) */
  resume?: string
}) {
  const { colors } = useTheme()
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    let disposed = false
    let term: Terminal | null = null
    let fitAddon: FitAddon | null = null
    let ptyId: string | null = null
    let unsubData: (() => void) | null = null
    let unsubExit: (() => void) | null = null
    let inputDisposable: { dispose: () => void } | null = null
    let resizeDisposable: { dispose: () => void } | null = null
    let observer: ResizeObserver | null = null

    // Wait for container to have real dimensions before opening xterm
    function tryOpen() {
      if (disposed) return
      const { offsetWidth, offsetHeight } = container
      if (offsetWidth === 0 || offsetHeight === 0) {
        requestAnimationFrame(tryOpen)
        return
      }
      init()
    }

    function init() {
      if (disposed) return

      term = new Terminal({
        fontFamily: "'Geist Mono', ui-monospace, 'SF Mono', 'Fira Code', monospace",
        fontSize: 13,
        lineHeight: 1.15,
        cursorBlink: true,
        cursorStyle: 'bar',
        theme: {
          background: colors.bgOverlay,
          foreground: colors.text,
          cursor: colors.blue,
          selectionBackground: `${colors.blue}40`,
          black: '#1a1a1a',
          red: colors.red,
          green: colors.green,
          yellow: colors.amber,
          blue: colors.blue,
          magenta: colors.purple,
          cyan: '#56d4dd',
          white: colors.text,
          brightBlack: colors.textMuted,
          brightRed: colors.red,
          brightGreen: colors.green,
          brightYellow: colors.amber,
          brightBlue: colors.blue,
          brightMagenta: colors.purple,
          brightCyan: '#56d4dd',
          brightWhite: '#ffffff',
        },
        allowProposedApi: true,
      })

      fitAddon = new FitAddon()
      term.loadAddon(fitAddon)
      term.loadAddon(new WebLinksAddon())

      term.open(container)
      try { fitAddon.fit() } catch { /* ignore */ }

      // Get or create PTY — use claude terminal or plain shell based on mode
      const createFn = mode === 'claude'
        ? api.createClaudeTerminal(agentId, cwd, resume)
        : api.createTerminal(agentId, cwd)

      createFn.then(async ({ terminalId, isNew }) => {
        if (disposed) return
        ptyId = terminalId

        // If reattaching to existing PTY, replay buffered output
        if (!isNew && term) {
          const { data } = await api.getTerminalBuffer(terminalId)
          if (data && term && !disposed) {
            term.write(data)
          }
        }

        // Send resize to match current xterm dimensions
        if (term) {
          const { cols, rows } = term
          if (cols && rows) {
            api.resizeTerminal(terminalId, cols, rows)
          }
        }
      })

      // PTY → xterm
      unsubData = api.onTerminalData(({ terminalId: tid, data }) => {
        if (tid === ptyId && term) {
          term.write(data)
        }
      })

      unsubExit = api.onTerminalExit(({ terminalId: tid }) => {
        if (tid === ptyId && term) {
          term.write('\r\n\x1b[90m[process exited]\x1b[0m\r\n')
        }
      })

      // xterm → PTY
      inputDisposable = term.onData((data: string) => {
        if (ptyId) {
          api.writeTerminal(ptyId, data)
        }
      })

      // Resize: xterm → PTY
      resizeDisposable = term.onResize(({ cols, rows }) => {
        if (ptyId) {
          api.resizeTerminal(ptyId, cols, rows)
        }
      })

      // Observe container resize → fit xterm
      observer = new ResizeObserver(() => {
        requestAnimationFrame(() => {
          try { fitAddon?.fit() } catch { /* container may be hidden */ }
        })
      })
      observer.observe(container)
    }

    requestAnimationFrame(tryOpen)

    return () => {
      disposed = true
      observer?.disconnect()
      inputDisposable?.dispose()
      resizeDisposable?.dispose()
      unsubData?.()
      unsubExit?.()
      term?.dispose()
      // NOTE: intentionally do NOT close the PTY here.
      // The PTY persists in the main process until the agent is closed.
    }
  }, [agentId, cwd, mode, resume]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      ref={containerRef}
      style={{
        width: '100%',
        height: '100%',
        background: colors.bgOverlay,
        overflow: 'hidden',
      }}
    />
  )
}
