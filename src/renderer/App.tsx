import React, { useState, useEffect, useCallback, useRef } from 'react'
import JourneyBar from './components/journey/JourneyBar'
import AgentGrid from './components/grid/AgentGrid'
import MinimizedAgentsPill from './components/grid/MinimizedAgentsPill'
import FileActivitySidebar from './components/activity/FileActivitySidebar'
import FileDetailModal from './components/activity/FileDetailModal'
import SourceControlSidebar from './components/scm/SourceControlSidebar'
import TerminalDrawer from './components/terminal/TerminalDrawer'
import CommandPalette from './components/palette/CommandPalette'
import ShortcutOverlay from './components/palette/ShortcutOverlay'
import SessionPicker from './components/palette/SessionPicker'
import HelpOverlay from './components/palette/HelpOverlay'
import { useAgentManager, saveSession } from './hooks/useAgentManager'
import { useAgent } from './hooks/useAgent'
import { useJourneyPhase } from './hooks/useJourneyPhase'
import { useFileActivity } from './hooks/useFileActivity'
import { useContextUsage } from './hooks/useContextUsage'
import { useApiUsage } from './hooks/useApiUsage'
import { useAuth } from './hooks/useAuth'
import { useTheme } from './ThemeContext'
import { getRecentFolders } from './hooks/useRecentFolders'
import { resolveAlias } from './components/palette/commands'
import { api } from './lib/api'
import SettingsPanel from './components/settings/SettingsPanel'
import type { TrackedFile, UIMessage } from '../shared/types'

/** Copy text to clipboard (works in Electron renderer) */
function copyToClipboard(text: string) {
  navigator.clipboard.writeText(text).catch(() => {
    // fallback
    const ta = document.createElement('textarea')
    ta.value = text
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    document.body.removeChild(ta)
  })
}

/** Find last assistant message text */
function getLastAssistantText(messages: UIMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].type === 'assistant') {
      return (messages[i] as Extract<UIMessage, { type: 'assistant' }>).text
    }
  }
  return null
}

/** Export conversation to plain text */
function exportConversation(messages: UIMessage[]): string {
  return messages.map(msg => {
    switch (msg.type) {
      case 'user': return `> ${msg.text}`
      case 'assistant': return msg.text
      case 'tool-use': return `[Tool: ${msg.toolName}]`
      case 'tool-result': return `[Result: ${msg.output.slice(0, 200)}]`
      case 'system': return `-- ${msg.text}`
      case 'error': return `!! ${msg.message}`
      case 'result': return `-- Done in ${(msg.duration / 1000).toFixed(1)}s · ${msg.numTurns} turns · $${msg.cost.toFixed(4)}`
      default: return ''
    }
  }).filter(Boolean).join('\n\n')
}

export default function App() {
  const { colors, spacing, agentColors, fonts, toggleTheme } = useTheme()

  const [showTerminal, setShowTerminal] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [selectedFile, setSelectedFile] = useState<TrackedFile | null>(null)
  const [showCommandPalette, setShowCommandPalette] = useState(false)
  const [showShortcutOverlay, setShowShortcutOverlay] = useState(false)
  const [showSessionPicker, setShowSessionPicker] = useState(false)
  const [showHelp, setShowHelp] = useState(false)
  const [anyAwaiting, setAnyAwaiting] = useState(false)
  const [editingTabId, setEditingTabId] = useState<string | null>(null)
  const [editingTabValue, setEditingTabValue] = useState('')
  const [minimizedView, setMinimizedView] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [activePanel, setActivePanel] = useState<'files' | 'scm'>('files')

  const manager = useAgentManager()
  const auth = useAuth()
  const [recentFolders, setRecentFolders] = useState(getRecentFolders)

  // Refresh recent folders whenever agent list changes (new agent = new recent entry)
  useEffect(() => {
    setRecentFolders(getRecentFolders())
  }, [manager.agents.length])

  // Handle --open-dir from CLI launcher
  useEffect(() => {
    const cleanup = api.onInitialCwd((cwd: string) => {
      if (cwd) {
        console.log('[App] received initial cwd from CLI:', cwd)
        manager.createAgent(cwd)
      }
    })
    return cleanup
  }, [])

  // Save session snapshot on window close
  useEffect(() => {
    const handler = () => saveSession(manager.agents, manager.focusedId)
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [manager.agents, manager.focusedId])

  // Track focused agent's state for JourneyBar / FileActivity / StatusBar
  const focusedAgent = useAgent(manager.focusedId || '__none__')
  const phaseInfo = useJourneyPhase(focusedAgent.messages, focusedAgent.isActive, focusedAgent.permissionRequest)
  const { files, totalFiles, loading: filesLoading } = useFileActivity(
    focusedAgent.messages,
    manager.focusedAgent?.id,
    manager.focusedAgent?.name,
    manager.focusedAgent?.cwd,
  )
  const contextUsage = useContextUsage()
  const apiUsage = useApiUsage()

  // Minimize to floating pill / restore
  const enterPillMode = useCallback(() => {
    if (minimizedView) return
    setMinimizedView(true)
    api.minimizeToPill(Math.max(1, manager.agents.length))
  }, [minimizedView, manager.agents.length])

  const exitPillMode = useCallback((focusAgentId?: string) => {
    if (!minimizedView) return
    setMinimizedView(false)
    api.restoreFromPill()
    if (focusAgentId) manager.focusAgent(focusAgentId)
  }, [minimizedView, manager])

  // Stable refs for volatile values so handleSlashCommand doesn't recreate
  const managerRef = useRef(manager)
  const focusedAgentRef = useRef(focusedAgent)
  const authRef = useRef(auth)
  useEffect(() => { managerRef.current = manager }, [manager])
  useEffect(() => { focusedAgentRef.current = focusedAgent }, [focusedAgent])
  useEffect(() => { authRef.current = auth }, [auth])

  // Handle slash commands from any agent cell
  const handleSlashCommand = useCallback((rawCmd: string) => {
    const manager = managerRef.current
    const focusedAgent = focusedAgentRef.current
    const auth = authRef.current
    const resolved = resolveAlias(rawCmd.trim())
    const parts = resolved.split(' ')
    const command = parts[0].toLowerCase()
    const arg = parts.slice(1).join(' ').trim()
    const agentId = manager.focusedId

    // Emit a system message through IPC so the AgentCell's useAgent picks it up
    const sysMsg = (text: string) => {
      if (agentId) api.emitSystemMessage(agentId, text)
    }

    // Helper: send command to SDK (the SDK handles it natively and returns output
    // via system messages with subtype 'local_command_output')
    const sendToSDK = () => {
      if (agentId) focusedAgent.sendMessage(rawCmd)
      else sysMsg('No active agent — create one first with /new')
    }

    switch (command) {
      // =====================================================================
      // UI-only commands — our app handles these, NOT the SDK
      // =====================================================================
      case '/help':
        setShowHelp(true)
        break
      case '/clear':
        focusedAgent.clearMessages()
        break
      case '/new':
        manager.createAgent()
        break
      case '/close':
        if (agentId) manager.closeAgent(agentId)
        break
      case '/terminal':
        setShowTerminal(v => !v)
        break
      case '/minimize':
        enterPillMode()
        break
      case '/files':
        setSidebarCollapsed(v => !v)
        break
      case '/scm':
        setActivePanel(p => p === 'scm' ? 'files' : 'scm')
        setSidebarCollapsed(false)
        break
      case '/theme':
        toggleTheme()
        break
      case '/keybindings':
        setShowShortcutOverlay(true)
        break
      case '/exit':
        window.close()
        break
      case '/agents':
        sysMsg(`Active agents: ${manager.agents.map(a => `${a.name} (${a.cwd})`).join(', ')}`)
        break
      case '/export': {
        const text = exportConversation(focusedAgent.messages)
        copyToClipboard(text)
        sysMsg(`Exported ${focusedAgent.messages.length} messages to clipboard`)
        break
      }
      case '/copy': {
        const lastText = getLastAssistantText(focusedAgent.messages)
        if (lastText) {
          copyToClipboard(lastText)
          sysMsg('Copied last response to clipboard')
        } else {
          sysMsg('No assistant response to copy')
        }
        break
      }
      case '/resume':
        if (arg) {
          if (agentId) focusedAgent.resumeSession(arg)
        } else {
          setShowSessionPicker(true)
        }
        break
      case '/continue':
        if (agentId) {
          sysMsg('Continuing most recent session...')
          focusedAgent.continueSession()
        }
        break
      case '/rename':
        if (arg && agentId) {
          manager.renameAgent(agentId, arg)
          sysMsg(`Renamed to: ${arg.trim().slice(0, 8)}`)
        } else {
          sysMsg('Usage: /rename <name> (max 8 chars)')
        }
        break
      case '/add-dir':
        if (arg) {
          sysMsg(`Added directory: ${arg}`)
        } else {
          api.openFolderDialog().then((path: string | null) => {
            if (path) sysMsg(`Added directory: ${path}`)
          })
        }
        break
      case '/diff':
        if (manager.focusedAgent?.cwd) {
          api.gitDiff(manager.focusedAgent.cwd).then((diff: string) => {
            sysMsg(diff?.trim() ? `Git diff:\n${diff.slice(0, 2000)}${diff.length > 2000 ? '\n...(truncated)' : ''}` : 'No uncommitted changes')
          })
        } else {
          sysMsg('No working directory set')
        }
        break

      // === Permission mode changes (our app manages these via SDK) ===
      case '/plan':
        if (agentId) {
          api.setPermissionMode(agentId, 'plan').then(() => {
            sysMsg('Plan mode — agent will plan without executing tools')
          })
        }
        break
      case '/accept-edits':
        if (agentId) {
          api.setPermissionMode(agentId, 'acceptEdits').then(() => {
            sysMsg('Accept edits — file edits auto-approved, other tools still ask')
          })
        }
        break
      case '/default-mode':
        if (agentId) {
          api.setPermissionMode(agentId, 'default').then(() => {
            sysMsg('Default mode — prompts for dangerous operations')
          })
        }
        break
      case '/yolo':
        if (agentId) {
          api.setPermissionMode(agentId, 'bypassPermissions').then(() => {
            sysMsg('Bypass mode — all permissions auto-approved (use with caution)')
          })
        }
        break
      case '/permissions':
        if (agentId) {
          if (arg === 'plan' || arg === 'acceptEdits' || arg === 'default' || arg === 'bypassPermissions' || arg === 'dontAsk') {
            api.setPermissionMode(agentId, arg).then(() => {
              sysMsg(`Permission mode set to: ${arg}`)
            })
          } else {
            api.getPermissionMode(agentId).then((mode: string) => {
              sysMsg(`Current mode: ${mode}\nAvailable: /permissions default | acceptEdits | plan | bypassPermissions | dontAsk`)
            })
          }
        }
        break

      // === Auth (our app handles login/logout) ===
      case '/login':
        auth.login()
        break
      case '/logout':
        auth.logout()
        break

      // =====================================================================
      // SDK-native commands — pass through to the SDK which handles them
      // and returns output via system messages (subtype: 'local_command_output')
      // =====================================================================
      case '/usage': {
        if (!agentId) { sysMsg('No active agent'); break }
        api.fetchUsage().then((data: any) => {
          if (data.error) { sysMsg(`Usage error: ${data.error}`); return }
          sysMsg('__usage__' + JSON.stringify(data))
        }).catch(() => sysMsg('Failed to fetch usage'))
        break
      }
      case '/model': {
        if (!agentId) { sysMsg('No active agent'); break }
        if (arg) {
          // /model <name> — switch model
          api.setModel(agentId, arg).then(() => {
            sysMsg(`Switched to ${arg}`)
          }).catch((e: any) => sysMsg(`Model error: ${e.message || e}`))
        } else {
          // /model — show current + available
          api.getModelInfo(agentId).then((info: any) => {
            sysMsg('__model__' + JSON.stringify(info))
          }).catch(() => sysMsg('Failed to get model info'))
        }
        break
      }
      case '/cost':
      case '/context':
      case '/doctor':
      case '/status':
      case '/compact':
      case '/memory':
      case '/init':
      case '/config':
      case '/mcp':
      case '/stats':
      case '/fast':
      case '/hooks':
      case '/skills':
      case '/fork':
      case '/btw':
      case '/pr-comments':
      case '/review':
      case '/security-review':
      case '/release-notes':
      case '/feedback':
      case '/insights':
      case '/tasks':
      case '/rewind':
      case '/sandbox':
      case '/vim':
      case '/statusline':
      case '/terminal-setup':
      case '/extra-usage':
      case '/privacy-settings':
      case '/remote-env':
      case '/upgrade':
      case '/plugin':
      case '/reload-plugins':
      case '/install-github-app':
      case '/install-slack-app':
      case '/desktop':
      case '/chrome':
      case '/mobile':
      case '/remote-control':
      case '/stickers':
      case '/passes':
      case '/ide':
      case '/bug':
        sendToSDK()
        break

      default:
        sendToSDK()
        break
    }
  }, [toggleTheme])

  // Handle command palette actions
  const handlePaletteAction = useCallback((action: string) => {
    const manager = managerRef.current
    const focusedAgent = focusedAgentRef.current
    const auth = authRef.current
    setShowCommandPalette(false)
    switch (action) {
      case 'new-agent': manager.createAgent(); break
      case 'close-agent': if (manager.focusedId) manager.closeAgent(manager.focusedId); break
      case 'toggle-terminal': setShowTerminal(v => !v); break
      case 'toggle-sidebar': setSidebarCollapsed(v => !v); break
      case 'clear': focusedAgent.clearMessages(); break
      case 'shortcuts': setShowShortcutOverlay(true); break
      case 'toggle-theme': toggleTheme(); break
      case 'login': auth.login(); break
      case 'logout': auth.logout(); break
      case 'resume': setShowSessionPicker(true); break
      case 'continue': handleSlashCommand('/continue'); break
      case 'compact': handleSlashCommand('/compact'); break
      case 'copy-last': handleSlashCommand('/copy'); break
      case 'export': handleSlashCommand('/export'); break
      case 'diff': handleSlashCommand('/diff'); break
      case 'init': handleSlashCommand('/init'); break
      case 'doctor': handleSlashCommand('/doctor'); break
      case 'add-dir': handleSlashCommand('/add-dir'); break
      case 'cost': handleSlashCommand('/cost'); break
      case 'context': handleSlashCommand('/context'); break
      case 'mode-plan': handleSlashCommand('/plan'); break
      case 'mode-accept-edits': handleSlashCommand('/accept-edits'); break
      case 'mode-default': handleSlashCommand('/default-mode'); break
      case 'mode-yolo': handleSlashCommand('/yolo'); break
      case 'minimize': enterPillMode(); break
      case 'toggle-scm': setActivePanel(p => p === 'scm' ? 'files' : 'scm'); setSidebarCollapsed(false); break
      case 'install-cli': {
        const agentId = manager.focusedId
        const sysMsg = (text: string) => { if (agentId) api.emitSystemMessage(agentId, text) }
        api.installCLI().then((result: any) => {
          if (result.success) {
            sysMsg(`CLI installed! You can now run 'fluidstate .' from any terminal.\nInstalled to: ${result.path}`)
          } else {
            sysMsg(`CLI install failed: ${result.error}`)
          }
        })
        break
      }
    }
  }, [handleSlashCommand, toggleTheme])

  // Handle session resume from picker
  const handleSessionSelect = useCallback((sessionId: string) => {
    setShowSessionPicker(false)
    if (manager.focusedId) {
      focusedAgent.resumeSession(sessionId)
    }
  }, [manager.focusedId, focusedAgent])

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey
      // Cmd+Shift+M — toggle pill mode
      if (meta && e.shiftKey && e.code === 'KeyM') {
        e.preventDefault()
        e.stopPropagation()
        if (minimizedView) exitPillMode()
        else enterPillMode()
        return
      }
      if (meta && e.key === '`') { e.preventDefault(); setShowTerminal(v => !v); return }
      if (meta && e.key === 'k') { e.preventDefault(); setShowCommandPalette(v => !v); return }
      if (meta && e.key === '?') { e.preventDefault(); setShowShortcutOverlay(v => !v); return }
      if (meta && e.key === 'n') { e.preventDefault(); manager.createAgent(); return }
      if (meta && e.key === 'w') { e.preventDefault(); if (manager.focusedId) manager.closeAgent(manager.focusedId); return }
      if (meta && e.key === 'b') { e.preventDefault(); setSidebarCollapsed(v => !v); return }
      if (meta && e.shiftKey && e.code === 'KeyG') { e.preventDefault(); setActivePanel(p => p === 'scm' ? 'files' : 'scm'); setSidebarCollapsed(false); return }
      if (meta && e.key >= '1' && e.key <= '4') { e.preventDefault(); manager.focusByIndex(parseInt(e.key) - 1); return }
      if (e.key === 'Escape') {
        if (showSessionPicker) { setShowSessionPicker(false); return }
        if (showHelp) { setShowHelp(false); return }
        if (showCommandPalette) { setShowCommandPalette(false); return }
        if (showShortcutOverlay) { setShowShortcutOverlay(false); return }
        if (focusedAgent.isActive) { focusedAgent.stopSession(); return }
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [manager, focusedAgent, showCommandPalette, showShortcutOverlay, showSessionPicker, showHelp, minimizedView, enterPillMode, exitPillMode])

  const terminalCwd = manager.focusedAgent?.cwd || '.'

  // Show login gate if not authenticated and done checking
  const needsLogin = !auth.loading && !auth.status.authenticated
  const cliMissing = auth.status.error?.includes('not found')

  // ── Pill mode: the entire window IS the pill ──
  if (minimizedView) {
    return (
      <MinimizedAgentsPill
        agents={manager.agents}
        agentColors={agentColors}
        onRestoreAgent={(id) => exitPillMode(id)}
      />
    )
  }

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: colors.bg, overflow: 'hidden' }}>
      {/* Auth gate overlay */}
      {needsLogin && (
        <div style={{
          position: 'absolute',
          inset: 0,
          zIndex: 1000,
          background: `${colors.bg}f0`,
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}>
          <div style={{
            textAlign: 'center',
            maxWidth: 420,
            padding: 40,
          }}>
            <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 12, opacity: 0.3 }}>Fluid State</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: colors.text, marginBottom: 8 }}>
              {cliMissing ? 'Claude CLI Not Found' : 'Sign In to Claude'}
            </div>
            <div style={{ fontSize: 13, color: colors.textSecondary, lineHeight: 1.6, marginBottom: 24 }}>
              {cliMissing
                ? 'Fluid State requires the Claude CLI. Install it first, then relaunch.'
                : auth.loading
                  ? 'Opening browser for authentication...'
                  : 'Fluid State uses your Claude account. Click below to sign in — your browser will open for authentication.'}
            </div>

            {cliMissing ? (
              <div style={{
                background: colors.bgSurface,
                border: `1px solid ${colors.border}`,
                borderRadius: 8,
                padding: '10px 16px',
                fontFamily: fonts.mono,
                fontSize: 12,
                color: colors.textLink,
                userSelect: 'all',
                marginBottom: 16,
              }}>
                npm install -g @anthropic-ai/claude-code
              </div>
            ) : (
              <button
                onClick={auth.login}
                disabled={auth.loading}
                style={{
                  background: auth.loading ? colors.borderMuted : colors.blue,
                  border: 'none',
                  color: '#fff',
                  borderRadius: 8,
                  padding: '10px 28px',
                  fontSize: 14,
                  fontWeight: 600,
                  cursor: auth.loading ? 'wait' : 'pointer',
                  transition: 'background 0.15s ease',
                  marginBottom: 16,
                }}
              >
                {auth.loading ? 'Waiting for browser...' : 'Sign In'}
              </button>
            )}

            {auth.status.error && !cliMissing && (
              <div style={{ fontSize: 12, color: colors.red, marginTop: 8 }}>
                {auth.status.error}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Title bar */}
      <div style={{
        height: spacing.titleBarHeight,
        background: anyAwaiting ? `${colors.red}18` : colors.bgOverlay,
        borderBottom: `1px solid ${anyAwaiting ? colors.red + '40' : colors.border}`,
        transition: 'background 0.3s ease, border-color 0.3s ease',
        display: 'flex',
        alignItems: 'center',
        padding: '0 16px',
        justifyContent: 'space-between',
        position: 'relative',
        WebkitAppRegion: 'drag' as any,
        userSelect: 'none',
      }}>
        {/* Left: title + agent tabs */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingLeft: 68 }}>
          <span style={{ fontSize: 13, fontWeight: 300, color: colors.text }}>Fluid State AI</span>
          {/* Agent position indicators */}
          {manager.agents.length > 1 && (
            <div style={{ display: 'flex', gap: 4, marginLeft: 6, WebkitAppRegion: 'no-drag' as any } as any}>
              {manager.agents.map((a, i) => (
                <div
                  key={a.id}
                  onClick={() => manager.focusAgent(a.id)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                    padding: '2px 8px',
                    borderRadius: 10,
                    fontSize: 10,
                    cursor: 'pointer',
                    fontFamily: fonts.mono,
                    background: a.id === manager.focusedId ? `${agentColors[i]}18` : 'transparent',
                    border: a.id === manager.focusedId ? `1px solid ${agentColors[i]}40` : '1px solid transparent',
                    color: a.id === manager.focusedId ? colors.text : colors.textMuted,
                    transition: 'all 0.15s ease',
                  }}
                >
                  <span style={{
                    width: 6, height: 6, borderRadius: '50%',
                    background: agentColors[i % agentColors.length],
                  }} />
                  {editingTabId === a.id ? (
                    <input
                      autoFocus
                      spellCheck={false}
                      maxLength={8}
                      value={editingTabValue}
                      onChange={e => { if (e.target.value.length <= 8) setEditingTabValue(e.target.value) }}
                      onKeyDown={e => {
                        if (e.key === 'Enter') {
                          e.stopPropagation()
                          const v = editingTabValue.trim()
                          if (v) manager.renameAgent(a.id, v)
                          setEditingTabId(null)
                        }
                        if (e.key === 'Escape') { e.stopPropagation(); setEditingTabId(null) }
                      }}
                      onBlur={() => {
                        const v = editingTabValue.trim()
                        if (v) manager.renameAgent(a.id, v)
                        setEditingTabId(null)
                      }}
                      onClick={e => e.stopPropagation()}
                      style={{
                        fontSize: 10,
                        fontFamily: fonts.mono,
                        color: colors.text,
                        background: `${agentColors[i]}12`,
                        border: `1px solid ${agentColors[i]}40`,
                        borderRadius: 3,
                        outline: 'none',
                        padding: '0 2px',
                        width: 56,
                      }}
                    />
                  ) : (
                    <span
                      onDoubleClick={e => {
                        e.stopPropagation()
                        setEditingTabValue(a.name)
                        setEditingTabId(a.id)
                      }}
                      title="Double-click to rename"
                    >
                      {a.name}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Center: phase pill — absolutely positioned for true centering */}
        {phaseInfo.phase !== 'idle' && phaseInfo.phase !== 'done' && (
          <div style={{
            position: 'absolute',
            left: '50%',
            transform: 'translateX(-50%)',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            pointerEvents: 'none',
          }}>
            <div style={{
              padding: '3px 10px',
              borderRadius: 12,
              fontSize: 11,
              fontWeight: 600,
              background: `${phaseInfo.color}15`,
              color: phaseInfo.color,
              border: `1px solid ${phaseInfo.color}30`,
              transition: 'all 0.3s ease',
            }}>
              {phaseInfo.label}
            </div>
          </div>
        )}

        {/* Right: new agent + theme toggle + terminal toggle */}
        <div style={{ WebkitAppRegion: 'no-drag' as any, display: 'flex', gap: 10, alignItems: 'center' }}>
          {manager.canAddAgent && (
            <span
              style={{ cursor: 'pointer', fontSize: 16, color: colors.textMuted, lineHeight: 1 }}
              onClick={() => manager.createAgent()}
              title="New Agent (Cmd+N)"
            >
              +
            </span>
          )}
          <span
            style={{ cursor: 'pointer', fontSize: 13, color: colors.textMuted }}
            onClick={toggleTheme}
            title="Toggle Theme"
          >
            {'\u25D0'}
          </span>
          <span
            style={{ cursor: 'pointer', fontSize: 14, color: colors.textMuted }}
            onClick={() => setShowTerminal(v => !v)}
            title="Toggle Terminal (Cmd+`)"
          >
            {'$_'}
          </span>
          <span
            style={{ cursor: 'pointer', fontSize: 14, color: showSettings ? colors.text : colors.textMuted, position: 'relative' }}
            onClick={() => setShowSettings(v => !v)}
            title="Settings"
          >
            {'\u2699'}
          </span>
        </div>

        {/* Settings panel dropdown */}
        {showSettings && (
          <SettingsPanel onClose={() => setShowSettings(false)} />
        )}
      </div>

      {/* Journey bar */}
      <JourneyBar agents={manager.agents} agentColors={agentColors} focusedId={manager.focusedId} onAnyAwaiting={setAnyAwaiting} />

      {/* Main content */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        <div style={{ flex: 1, overflow: 'hidden', minWidth: 0 }}>
          <AgentGrid
            agents={manager.agents}
            focusedId={manager.focusedId}
            canAddAgent={manager.canAddAgent}
            onFocus={manager.focusAgent}
            onClose={manager.closeAgent}
            onAddAgent={() => manager.createAgent()}
            onSlashCommand={handleSlashCommand}
            onReorder={manager.reorderAgents}
            onRename={manager.renameAgent}
            recentFolders={recentFolders}
            onOpenRecent={(path) => manager.createAgent(path)}
          />
        </div>

        {/* Sidebar with panel switcher */}
        {sidebarCollapsed ? (
          <div
            onClick={() => setSidebarCollapsed(false)}
            style={{
              width: 36,
              borderLeft: `1px solid ${colors.border}`,
              background: colors.bgOverlay,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              writingMode: 'vertical-rl',
              fontSize: 11,
              color: colors.textMuted,
              letterSpacing: 1,
              userSelect: 'none',
            }}
          >
            {activePanel === 'scm' ? 'Source Control' : `Files (${files.length})`}
          </div>
        ) : (
          <div style={{
            width: 280,
            borderLeft: `1px solid ${colors.border}`,
            background: colors.bgOverlay,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            flexShrink: 0,
          }}>
            {/* Panel switcher tabs */}
            <div style={{
              display: 'flex',
              borderBottom: `1px solid ${colors.border}`,
              userSelect: 'none',
              flexShrink: 0,
            }}>
              <PanelTab
                label="Files"
                active={activePanel === 'files'}
                onClick={() => setActivePanel('files')}
              />
              <PanelTab
                label="SCM"
                active={activePanel === 'scm'}
                onClick={() => setActivePanel('scm')}
                badge={undefined}
              />
              <div style={{ flex: 1 }} />
              <span
                onClick={() => setSidebarCollapsed(true)}
                style={{ cursor: 'pointer', fontSize: 14, color: colors.textMuted, padding: '6px 10px' }}
                title="Collapse sidebar"
              >
                {'\u00BB'}
              </span>
            </div>
            {/* Active panel content */}
            <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
              {activePanel === 'scm' ? (
                <SourceControlSidebar
                  cwd={manager.focusedAgent?.cwd}
                  collapsed={false}
                  onToggle={() => setSidebarCollapsed(true)}
                />
              ) : (
                <FileActivitySidebar
                  files={files}
                  collapsed={false}
                  loading={filesLoading}
                  onToggle={() => setSidebarCollapsed(true)}
                  onFileClick={(file) => setSelectedFile(file)}
                  agentName={manager.agents.length > 1 ? manager.focusedAgent?.name : undefined}
                />
              )}
            </div>
          </div>
        )}
      </div>

      {/* Terminal drawer */}
      <TerminalDrawer
        agentId={manager.focusedAgent?.id || ''}
        cwd={terminalCwd}
        visible={showTerminal && !!manager.focusedAgent}
        onToggle={() => setShowTerminal(false)}
      />

      {/* Status bar */}
      <div style={{
        height: spacing.statusBarHeight,
        background: colors.bgOverlay,
        borderTop: `1px solid ${colors.border}`,
        display: 'flex',
        alignItems: 'center',
        padding: '0 12px',
        justifyContent: 'space-between',
        fontSize: 11,
        color: colors.textMuted,
        userSelect: 'none',
      }}>
        <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
          <span style={{ color: phaseInfo.color, fontWeight: 500 }}>
            {phaseInfo.phase !== 'idle' ? phaseInfo.label : 'Fluid State'}
          </span>
          {phaseInfo.detail && (
            <span>{phaseInfo.detail}</span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
          {apiUsage.sessionPct != null && (
            <span
              style={{
                fontFamily: fonts.mono,
                color: apiUsage.sessionPct > 80 ? colors.red : apiUsage.sessionPct > 50 ? colors.amber : colors.textMuted,
              }}
              title={`5h session: ${apiUsage.sessionPct}%${apiUsage.sessionReset ? ` · resets ${apiUsage.sessionReset}` : ''}${apiUsage.weekPct != null ? `\n7d week: ${apiUsage.weekPct}%` : ''}${apiUsage.extraSpent != null ? `\nExtra: $${apiUsage.extraSpent.toFixed(2)}${apiUsage.extraLimit != null ? ` / $${apiUsage.extraLimit.toFixed(2)}` : ''}` : ''}`}
            >
              {apiUsage.sessionPct}%{apiUsage.sessionReset ? ` · ${apiUsage.sessionReset}` : ''}
            </span>
          )}
          <span>{totalFiles} files</span>
          {focusedAgent.isActive && (
            <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{
                width: 6, height: 6, borderRadius: '50%', background: colors.green,
                animation: 'pulse 1.5s infinite',
              }} />
              Active
            </span>
          )}
          <span
            onClick={auth.status.authenticated ? undefined : auth.login}
            style={{
              display: 'flex', alignItems: 'center', gap: 4,
              cursor: auth.status.authenticated ? 'default' : 'pointer',
            }}
            title={auth.status.authenticated
              ? `Logged in${auth.status.email ? ` as ${auth.status.email}` : ''}${auth.status.organization ? ` (${auth.status.organization})` : ''}`
              : auth.status.error || 'Not logged in — click to log in'}
          >
            <span style={{
              width: 6, height: 6, borderRadius: '50%',
              background: auth.loading ? colors.amber : auth.status.authenticated ? colors.green : colors.red,
              transition: 'background 0.3s ease',
            }} />
            {auth.loading ? 'Authenticating...'
              : auth.status.authenticated
                ? (auth.status.email || 'Logged in')
                : 'Not logged in'}
          </span>
        </div>
      </div>

      {selectedFile && (
        <FileDetailModal file={selectedFile} cwd={manager.focusedAgent?.cwd} onClose={() => setSelectedFile(null)} />
      )}
      {showCommandPalette && (
        <CommandPalette onAction={handlePaletteAction} onClose={() => setShowCommandPalette(false)} />
      )}
      {showShortcutOverlay && (
        <ShortcutOverlay onClose={() => setShowShortcutOverlay(false)} />
      )}
      {showSessionPicker && (
        <SessionPicker
          cwd={manager.focusedAgent?.cwd}
          onSelect={handleSessionSelect}
          onClose={() => setShowSessionPicker(false)}
        />
      )}
      {showHelp && (
        <HelpOverlay onClose={() => setShowHelp(false)} />
      )}
    </div>
  )
}

function PanelTab({ label, active, onClick, badge }: { label: string; active: boolean; onClick: () => void; badge?: number }) {
  const { colors } = useTheme()
  return (
    <div
      onClick={onClick}
      style={{
        padding: '6px 14px',
        fontSize: 11,
        fontWeight: active ? 600 : 400,
        color: active ? colors.text : colors.textMuted,
        cursor: 'pointer',
        borderBottom: active ? `2px solid ${colors.blue}` : '2px solid transparent',
        transition: 'all 0.15s ease',
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        userSelect: 'none',
      }}
    >
      {label}
      {badge !== undefined && badge > 0 && (
        <span style={{
          fontSize: 9,
          background: colors.blue,
          color: '#fff',
          borderRadius: 8,
          padding: '1px 5px',
          fontWeight: 600,
        }}>
          {badge}
        </span>
      )}
    </div>
  )
}
