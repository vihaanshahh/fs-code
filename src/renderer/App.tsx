import React, { useState, useEffect, useCallback } from 'react'
import FileExplorer from './components/explorer/FileExplorer'
import Editor from './components/editor/Editor'
import ChatPanel from './components/chat/ChatPanel'
import TerminalPanel from './components/terminal/Terminal'
import { useAgent } from './hooks/useAgent'
import { useFileTree } from './hooks/useFileTree'
import { useEditor } from './hooks/useEditor'

type SidePanel = 'explorer' | 'chat'

const CWD = '.'

export default function App() {
  const [sidePanel, setSidePanel] = useState<SidePanel>('chat')
  const [showTerminal, setShowTerminal] = useState(false)
  const [sidePanelWidth, setSidePanelWidth] = useState(260)
  const [chatWidth, setChatWidth] = useState(380)
  const [bottomHeight, setBottomHeight] = useState(200)
  const [resizing, setResizing] = useState<string | null>(null)

  const agent = useAgent()
  const fileTree = useFileTree(CWD)
  const editor = useEditor()

  // Load file tree on mount
  useEffect(() => { fileTree.refresh() }, [])

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        if (editor.activeFilePath) editor.saveFile(editor.activeFilePath)
      }
      if ((e.metaKey || e.ctrlKey) && e.key === '`') {
        e.preventDefault()
        setShowTerminal(v => !v)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [editor.activeFilePath])

  // Resizing
  useEffect(() => {
    if (!resizing) return
    const onMove = (e: MouseEvent) => {
      if (resizing === 'side') setSidePanelWidth(Math.max(160, Math.min(400, e.clientX - 48)))
      if (resizing === 'chat') setChatWidth(Math.max(280, Math.min(600, window.innerWidth - e.clientX)))
      if (resizing === 'bottom') setBottomHeight(Math.max(80, Math.min(500, window.innerHeight - e.clientY)))
    }
    const onUp = () => setResizing(null)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
  }, [resizing])

  const handleStartAgent = useCallback((cwd: string) => {
    agent.startSession(cwd || CWD)
  }, [agent])

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: '#0d1117', overflow: 'hidden' }}>
      {/* Title bar */}
      <div style={{
        height: 38, background: '#010409', borderBottom: '1px solid #21262d',
        display: 'flex', alignItems: 'center', padding: '0 80px 0 16px',
        justifyContent: 'space-between',
        WebkitAppRegion: 'drag' as any, userSelect: 'none',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 16 }}>⚡</span>
          <span style={{ fontSize: 13, fontWeight: 700, color: '#e6edf3' }}>FS Code</span>
        </div>
        <div style={{ display: 'flex', gap: 12, fontSize: 11, color: '#8b949e', WebkitAppRegion: 'no-drag' as any }}>
          {agent.isActive && <span style={{ color: '#3fb950' }}>● Agent active</span>}
          <span style={{ cursor: 'pointer' }} onClick={() => setShowTerminal(v => !v)}>
            {showTerminal ? 'Hide Terminal' : 'Show Terminal'}
          </span>
        </div>
      </div>

      {/* Main area */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* Activity bar */}
        <div style={{
          width: 48, background: '#010409', borderRight: '1px solid #21262d',
          display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '8px 0', gap: 4,
        }}>
          {([
            { id: 'explorer' as const, icon: '📁', label: 'Explorer' },
            { id: 'chat' as const, icon: '⚡', label: 'Agent' },
          ]).map(item => (
            <div
              key={item.id}
              title={item.label}
              style={{
                width: 40, height: 40, display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 18, cursor: 'pointer', borderRadius: 6,
                background: sidePanel === item.id ? '#21262d' : 'transparent',
                borderLeft: sidePanel === item.id ? '2px solid #58a6ff' : '2px solid transparent',
                position: 'relative',
              }}
              onClick={() => setSidePanel(item.id)}
            >
              {item.icon}
              {item.id === 'chat' && agent.isActive && (
                <span style={{
                  position: 'absolute', top: 4, right: 4, width: 7, height: 7,
                  borderRadius: '50%', background: '#3fb950',
                }} />
              )}
            </div>
          ))}
        </div>

        {/* Left side panel (explorer) */}
        {sidePanel === 'explorer' && (
          <>
            <div style={{ width: sidePanelWidth, borderRight: '1px solid #21262d', overflow: 'hidden', flexShrink: 0 }}>
              <FileExplorer
                tree={fileTree.tree}
                selectedPath={editor.activeFilePath || undefined}
                onSelect={(path) => editor.openFile(path)}
                onRefresh={fileTree.refresh}
              />
            </div>
            <div
              style={{ width: 4, cursor: 'col-resize', background: resizing === 'side' ? '#58a6ff' : 'transparent' }}
              onMouseDown={() => setResizing('side')}
              onMouseEnter={e => { if (!resizing) e.currentTarget.style.background = '#21262d' }}
              onMouseLeave={e => { if (!resizing) e.currentTarget.style.background = 'transparent' }}
            />
          </>
        )}

        {/* Center: Editor + Terminal */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>
          <div style={{ flex: 1, overflow: 'hidden' }}>
            <Editor
              openFiles={editor.openFiles}
              activeFile={editor.activeFile}
              onFileSelect={editor.setActiveFilePath}
              onFileClose={editor.closeFile}
              onContentChange={editor.updateContent}
              onSave={editor.saveFile}
            />
          </div>

          {showTerminal && (
            <>
              <div
                style={{ height: 4, cursor: 'row-resize', background: resizing === 'bottom' ? '#58a6ff' : 'transparent' }}
                onMouseDown={() => setResizing('bottom')}
                onMouseEnter={e => { if (!resizing) e.currentTarget.style.background = '#21262d' }}
                onMouseLeave={e => { if (!resizing) e.currentTarget.style.background = 'transparent' }}
              />
              <div style={{ height: bottomHeight, borderTop: '1px solid #21262d', overflow: 'hidden' }}>
                <TerminalPanel cwd={CWD} />
              </div>
            </>
          )}
        </div>

        {/* Right: Chat panel resize handle */}
        <div
          style={{ width: 4, cursor: 'col-resize', background: resizing === 'chat' ? '#58a6ff' : 'transparent' }}
          onMouseDown={() => setResizing('chat')}
          onMouseEnter={e => { if (!resizing) e.currentTarget.style.background = '#21262d' }}
          onMouseLeave={e => { if (!resizing) e.currentTarget.style.background = 'transparent' }}
        />

        {/* Right: Chat panel (always visible) */}
        <div style={{ width: chatWidth, borderLeft: '1px solid #21262d', overflow: 'hidden', flexShrink: 0 }}>
          <ChatPanel
            messages={agent.messages}
            isActive={agent.isActive}
            permissionRequest={agent.permissionRequest}
            onSendMessage={agent.sendMessage}
            onStop={agent.stopSession}
            onStart={handleStartAgent}
            onRespondPermission={agent.respondPermission}
          />
        </div>
      </div>

      {/* Status bar */}
      <div style={{
        height: 24, background: '#010409', borderTop: '1px solid #21262d',
        display: 'flex', alignItems: 'center', padding: '0 12px', justifyContent: 'space-between',
        fontSize: 11, color: '#8b949e',
      }}>
        <div style={{ display: 'flex', gap: 16 }}>
          <span>⚡ FS Code</span>
          {agent.isActive && <span style={{ color: '#3fb950' }}>● Agent</span>}
          {agent.sessionId && <span>Session: {agent.sessionId.slice(0, 8)}</span>}
        </div>
        <div style={{ display: 'flex', gap: 16 }}>
          {editor.activeFilePath && <span>{editor.activeFilePath}</span>}
          <span>{editor.openFiles.length} open</span>
        </div>
      </div>
    </div>
  )
}
