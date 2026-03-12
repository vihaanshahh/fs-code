import React from 'react'
import MonacoEditor from '@monaco-editor/react'
import type { OpenFile } from '../../hooks/useEditor'

export default function Editor({
  openFiles, activeFile, onFileSelect, onFileClose, onContentChange, onSave,
}: {
  openFiles: OpenFile[]
  activeFile: OpenFile | null
  onFileSelect: (path: string) => void
  onFileClose: (path: string) => void
  onContentChange: (path: string, content: string) => void
  onSave: (path: string) => void
}) {
  if (!activeFile) {
    return (
      <div style={{
        height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexDirection: 'column', gap: 12, color: '#484f58',
      }}>
        <span style={{ fontSize: 48, opacity: 0.3 }}>⚡</span>
        <span style={{ fontSize: 14 }}>FS Code</span>
        <span style={{ fontSize: 12, color: '#30363d' }}>Open a file from the explorer</span>
      </div>
    )
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Tab bar */}
      <div style={{
        display: 'flex', background: '#010409', borderBottom: '1px solid #21262d',
        overflow: 'auto', minHeight: 36,
      }}>
        {openFiles.map(f => {
          const isActive = f.path === activeFile.path
          const name = f.path.split('/').pop() || f.path
          return (
            <div
              key={f.path}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '6px 12px', cursor: 'pointer', fontSize: 12,
                color: isActive ? '#e6edf3' : '#8b949e',
                background: isActive ? '#0d1117' : 'transparent',
                borderBottom: isActive ? '2px solid #58a6ff' : '2px solid transparent',
                borderRight: '1px solid #21262d',
                whiteSpace: 'nowrap',
              }}
              onClick={() => onFileSelect(f.path)}
            >
              <span>{name}</span>
              {f.isDirty && <span style={{ color: '#d29922', fontSize: 8 }}>●</span>}
              <span
                style={{ fontSize: 12, color: '#484f58', padding: '0 2px', borderRadius: 3 }}
                onClick={(e) => { e.stopPropagation(); onFileClose(f.path) }}
                onMouseEnter={e => { (e.currentTarget.style.color = '#e6edf3') }}
                onMouseLeave={e => { (e.currentTarget.style.color = '#484f58') }}
              >×</span>
            </div>
          )
        })}
      </div>

      {/* Monaco */}
      <div style={{ flex: 1 }}>
        <MonacoEditor
          theme="vs-dark"
          language={activeFile.language}
          value={activeFile.content}
          onChange={(val) => val !== undefined && onContentChange(activeFile.path, val)}
          options={{
            fontSize: 13,
            fontFamily: "'SF Mono', 'Fira Code', 'JetBrains Mono', monospace",
            minimap: { enabled: false },
            lineNumbers: 'on',
            scrollBeyondLastLine: false,
            padding: { top: 8 },
            smoothScrolling: true,
            cursorSmoothCaretAnimation: 'on',
            renderLineHighlight: 'line',
            bracketPairColorization: { enabled: true },
          }}
          onMount={(editor) => {
            // Cmd+S to save
            editor.addCommand(2097 /* KeyMod.CtrlCmd | KeyCode.KeyS */, () => {
              onSave(activeFile.path)
            })
          }}
        />
      </div>
    </div>
  )
}
