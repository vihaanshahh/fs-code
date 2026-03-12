import React, { useState } from 'react'
import type { FileEntry } from '../../../shared/types'

const EXT_ICONS: Record<string, string> = {
  ts: '⬡', tsx: '⬡', js: '◆', jsx: '◆', json: '{ }', md: 'M',
  css: '#', html: '<>', py: '🐍', rs: '⚙', go: 'G', sh: '$',
}

function getIcon(name: string, type: 'file' | 'directory', isOpen?: boolean): string {
  if (type === 'directory') return isOpen ? '▾' : '▸'
  const ext = name.split('.').pop() || ''
  return EXT_ICONS[ext] || '·'
}

function TreeNode({
  entry, depth, selectedPath, onSelect,
}: {
  entry: FileEntry
  depth: number
  selectedPath?: string
  onSelect: (path: string) => void
}) {
  const [expanded, setExpanded] = useState(depth < 1)
  const isDir = entry.type === 'directory'
  const isSelected = entry.path === selectedPath

  return (
    <>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          padding: '2px 8px 2px ' + (12 + depth * 16) + 'px',
          cursor: 'pointer',
          fontSize: 13,
          color: isSelected ? '#e6edf3' : '#8b949e',
          background: isSelected ? '#1f6feb22' : 'transparent',
          borderLeft: isSelected ? '2px solid #58a6ff' : '2px solid transparent',
          userSelect: 'none',
        }}
        onClick={() => {
          if (isDir) setExpanded(!expanded)
          else onSelect(entry.path)
        }}
        onMouseEnter={e => { if (!isSelected) (e.currentTarget.style.background = '#161b22') }}
        onMouseLeave={e => { if (!isSelected) (e.currentTarget.style.background = 'transparent') }}
      >
        <span style={{
          width: 18, fontSize: 11, color: isDir ? '#e6edf3' : '#484f58',
          fontFamily: 'monospace', flexShrink: 0,
        }}>
          {getIcon(entry.name, entry.type, expanded)}
        </span>
        <span style={{
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          color: isDir ? '#e6edf3' : '#8b949e',
        }}>
          {entry.name}
        </span>
      </div>
      {isDir && expanded && entry.children?.map(child => (
        <TreeNode
          key={child.path}
          entry={child}
          depth={depth + 1}
          selectedPath={selectedPath}
          onSelect={onSelect}
        />
      ))}
    </>
  )
}

export default function FileExplorer({
  tree, selectedPath, onSelect, onRefresh,
}: {
  tree: FileEntry[]
  selectedPath?: string
  onSelect: (path: string) => void
  onRefresh: () => void
}) {
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: '#0d1117' }}>
      <div style={{
        padding: '10px 12px',
        borderBottom: '1px solid #21262d',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}>
        <span style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', color: '#8b949e', letterSpacing: 1 }}>
          Explorer
        </span>
        <button
          onClick={onRefresh}
          style={{
            background: 'none', border: 'none', color: '#8b949e', cursor: 'pointer',
            fontSize: 14, padding: '2px 4px',
          }}
          title="Refresh"
        >↻</button>
      </div>
      <div style={{ flex: 1, overflow: 'auto', paddingTop: 4 }}>
        {tree.map(entry => (
          <TreeNode
            key={entry.path}
            entry={entry}
            depth={0}
            selectedPath={selectedPath}
            onSelect={onSelect}
          />
        ))}
      </div>
    </div>
  )
}
