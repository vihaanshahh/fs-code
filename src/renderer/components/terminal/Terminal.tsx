import React, { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { api } from '../../lib/api'
import { useTheme } from '../../ThemeContext'
import { clearAgentAwaitingSnapshot, setAgentPhaseSnapshot } from '../../hooks/useAgent'

// ── Centralized terminal data dispatcher ──
// Instead of N terminal panels each subscribing to all TERM_DATA events
// and filtering by ID (O(N) listeners per event), we maintain a single
// global listener that dispatches to the correct terminal.
// At 9 agents streaming, this reduces IPC handler invocations from 9→1 per event.

type TermDataHandler = (data: string) => void
type TermExitHandler = () => void

const dataHandlers = new Map<string, TermDataHandler>()
const exitHandlers = new Map<string, TermExitHandler>()
// Generation counter per terminal ID — prevents stale cleanup from deleting new handler
const handlerGenerations = new Map<string, number>()
let globalListenersSetup = false

function normalizeTerminalScreen(text: string): string {
  return text
    .replace(/\r/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\n+/g, '\n')
    .toLowerCase()
}

function screenShowsAwaitingPrompt(text: string): boolean {
  const normalized = normalizeTerminalScreen(text)
  const hasPrompt = /\b(do you want to proceed|approve\b|permission required|confirm this action|needs your approval)\b/.test(normalized)
  const hasMenu =
    /(?:^|\n)\s*(?:❯\s*)?1\. yes\b/.test(normalized)
    && /(?:^|\n)\s*2\. yes,? and always allow\b/.test(normalized)
    && /(?:^|\n)\s*3\. no\b/.test(normalized)
  const hasAllowDeny = /\ballow\b|\bdeny\b|\bproceed\b/.test(normalized)
  return (hasPrompt && hasMenu) || (hasPrompt && hasAllowDeny)
}

function screenShowsClaudePrompt(text: string): boolean {
  const normalized = normalizeTerminalScreen(text)
  const lines = normalized.split('\n').map(line => line.trim()).filter(Boolean)
  const last = lines[lines.length - 1] || ''
  return last === '❯' || last === '>' || /^❯ /.test(last)
}

function ensureGlobalListeners() {
  if (globalListenersSetup) return
  globalListenersSetup = true

  api.onTerminalData(({ terminalId, data }) => {
    const handler = dataHandlers.get(terminalId)
    if (handler) handler(data)
  })

  api.onTerminalExit(({ terminalId }) => {
    const handler = exitHandlers.get(terminalId)
    if (handler) handler()
  })
}

export default function TerminalPanel({
  agentId,
  cwd,
  mode = 'shell',
  resume,
  provider,
}: {
  agentId: string
  cwd: string
  /** 'claude' launches claude CLI; 'codex' launches codex CLI; 'shell' is a plain shell */
  mode?: 'shell' | 'claude' | 'codex'
  /** Session ID to resume (only used in claude mode) */
  resume?: string
  /** Provider ID — used for display purposes */
  provider?: string
}) {
  const { colors } = useTheme()
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const isCli = mode === 'claude' || mode === 'codex'
  const [ready, setReady] = useState(!isCli)

  useEffect(() => {
    ensureGlobalListeners()

    const container = containerRef.current
    if (!container) return

    let disposed = false
    let term: Terminal | null = null
    let fitAddon: FitAddon | null = null
    let ptyId: string | null = null
    let ptyGen = 0 // generation counter for handler cleanup safety
    let inputDisposable: { dispose: () => void } | null = null
    let resizeDisposable: { dispose: () => void } | null = null
    let observer: ResizeObserver | null = null
    let inspectTimer: ReturnType<typeof setTimeout> | null = null
    let lastScreenPhase: 'awaiting' | 'idle' | 'none' = 'none'

    function inspectTerminalScreen() {
      if (!term || disposed || mode !== 'claude') return
      const active = (term as any).buffer?.active
      if (!active) return

      const cursor = active.baseY + active.cursorY
      const start = Math.max(0, cursor - 18)
      const end = Math.min(active.length - 1, cursor + 2)
      const lines: string[] = []
      for (let i = start; i <= end; i++) {
        const line = active.getLine(i)
        if (!line) continue
        lines.push(line.translateToString(true))
      }

      const screenText = lines.join('\n')
      if (screenShowsAwaitingPrompt(screenText)) {
        if (lastScreenPhase !== 'awaiting') {
          lastScreenPhase = 'awaiting'
          setAgentPhaseSnapshot(agentId, {
            phase: 'awaiting',
            detail: 'Needs attention',
            startedAt: Date.now(),
          })
        }
      } else if (screenShowsClaudePrompt(screenText)) {
        if (lastScreenPhase !== 'idle') {
          lastScreenPhase = 'idle'
          setAgentPhaseSnapshot(agentId, {
            phase: 'idle',
            detail: '',
            startedAt: Date.now(),
          })
        }
      } else if (lastScreenPhase !== 'none') {
        lastScreenPhase = 'none'
        clearAgentAwaitingSnapshot(agentId)
      }
    }

    function scheduleInspect() {
      if (inspectTimer) return
      inspectTimer = setTimeout(() => {
        inspectTimer = null
        inspectTerminalScreen()
      }, 50)
    }

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
          black: colors.bgOverlay,
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
      fitRef.current = fitAddon
      term.loadAddon(fitAddon)
      term.loadAddon(new WebLinksAddon())
      termRef.current = term

      term.open(container)
      try { fitAddon.fit() } catch { /* ignore */ }

      // Get or create PTY based on mode
      const createFn = mode === 'claude'
        ? api.createClaudeTerminal(agentId, cwd, resume)
        : mode === 'codex'
          ? api.createCodexTerminal(agentId, cwd)
          : api.createTerminal(agentId, cwd)

      createFn.then(async ({ terminalId, isNew }) => {
        if (disposed) return
        ptyId = terminalId

        // Register handler BEFORE replaying buffer to avoid missing data
        // Use generation counter to guard against stale cleanup race
        ptyGen = (handlerGenerations.get(terminalId) || 0) + 1
        handlerGenerations.set(terminalId, ptyGen)
        let gotPrompt = false
        dataHandlers.set(terminalId, (data: string) => {
          if (term && !disposed) {
            term.write(data, () => {
              if (!disposed) scheduleInspect()
            })
          }
          // Consider ready only once the CLI prompt appears:
          // Claude uses ❯, Codex uses > at start of line or "codex>" prompt
          if (isCli && !disposed && !gotPrompt) {
            if (mode === 'claude' && (data.includes('❯') || data.includes('\u276f'))) {
              gotPrompt = true
              setReady(true)
            } else if (mode === 'codex' && (data.includes('>') || data.includes('codex'))) {
              gotPrompt = true
              setReady(true)
            }
          }
        })
        // Fallback: always show terminal after a timeout
        if (isCli) {
          setTimeout(() => { if (!disposed) setReady(true) }, 8000)
        }

        const cliName = mode === 'codex' ? 'codex' : 'claude'
        exitHandlers.set(terminalId, () => {
          if (term && !disposed) term.write(`\r\n\x1b[90m[process exited — type \`${cliName}\` to restart]\x1b[0m\r\n`)
        })

        // If reattaching to existing PTY, replay buffered output
        if (!isNew && term) {
          const { data } = await api.getTerminalBuffer(terminalId)
          if (data && term && !disposed) {
            term.write(data, () => {
              if (!disposed) scheduleInspect()
            })
            if (isCli) {
              gotPrompt = true
              setReady(true)
            }
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

      // xterm → PTY
      inputDisposable = term.onData((data: string) => {
        if (ptyId) {
          api.writeTerminal(ptyId, data)
        }
        scheduleInspect()
      })

      // Resize: xterm → PTY
      resizeDisposable = term.onResize(({ cols, rows }) => {
        if (ptyId) {
          api.resizeTerminal(ptyId, cols, rows)
        }
      })

      // Observe container resize → fit xterm
      // Skip fitting when container is hidden (0 dimensions) to avoid
      // collapsing the terminal to 0 cols/rows when switching tabs.
      observer = new ResizeObserver(() => {
        requestAnimationFrame(() => {
          if (!container || container.offsetWidth === 0 || container.offsetHeight === 0) return
          try { fitAddon?.fit() } catch { /* container may be hidden */ }
        })
      })
      observer.observe(container)
    }

    requestAnimationFrame(tryOpen)

    return () => {
      disposed = true
      if (inspectTimer) clearTimeout(inspectTimer)
      observer?.disconnect()
      inputDisposable?.dispose()
      resizeDisposable?.dispose()
      if (ptyId) {
        // Only delete handlers if this cleanup owns the current generation
        // (prevents new mount's handler from being deleted by old mount's cleanup)
        if (handlerGenerations.get(ptyId) === ptyGen) {
          dataHandlers.delete(ptyId)
          exitHandlers.delete(ptyId)
        }
      }
      termRef.current = null
      fitRef.current = null
      term?.dispose()
      // NOTE: intentionally do NOT close the PTY here.
      // The PTY persists in the main process until the agent is closed.
    }
  }, [agentId, cwd, mode, resume]) // eslint-disable-line react-hooks/exhaustive-deps

  // Re-fit when container becomes visible (tab switch with visibility:hidden)
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const obs = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting && fitRef.current && container.offsetWidth > 0) {
        requestAnimationFrame(() => {
          try { fitRef.current?.fit() } catch { /* ignore */ }
        })
      }
    }, { threshold: 0.1 })
    obs.observe(container)
    return () => obs.disconnect()
  }, [])

  // Live theme update — patches xterm colors without reinitializing the terminal
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.theme = {
      background: colors.bgOverlay,
      foreground: colors.text,
      cursor: colors.blue,
      selectionBackground: `${colors.blue}40`,
      black: colors.bgOverlay,
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
    }
  }, [colors])

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <div
        ref={containerRef}
        style={{
          width: '100%',
          height: '100%',
          background: colors.bgOverlay,
          overflow: 'hidden',
        }}
      />
      {/* Loading overlay — shown while CLI initializes */}
      {!ready && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background: colors.bgOverlay,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 14,
            zIndex: 10,
            animation: 'fadeIn 0.15s ease',
          }}
        >
          {/* Spinner */}
          <div style={{
            width: 28,
            height: 28,
            border: `2px solid ${colors.border}`,
            borderTopColor: colors.blue,
            borderRadius: '50%',
            animation: 'spin 0.8s linear infinite',
          }} />
          <span style={{
            fontSize: 12,
            color: colors.textMuted,
            fontWeight: 500,
            letterSpacing: 0.3,
          }}>
            Initializing {mode === 'codex' ? 'Codex' : 'Claude'}...
          </span>
          <style>{`
            @keyframes spin { to { transform: rotate(360deg) } }
            @keyframes fadeIn { from { opacity: 0 } to { opacity: 1 } }
          `}</style>
        </div>
      )}
    </div>
  )
}
