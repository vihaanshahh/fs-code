import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useTheme } from '../../ThemeContext'
import { api } from '../../lib/api'
import type { FileEntry } from '../../../shared/types'
import DiffView from '../scm/DiffView'

interface GitInfo {
  status: string
}

function getStatusBadge(status: string): { letter: string; colorKey: 'amber' | 'green' | 'red' | 'purple' } {
  switch (status) {
    case 'modified': return { letter: 'M', colorKey: 'amber' }
    case 'added': return { letter: 'A', colorKey: 'green' }
    case 'deleted': return { letter: 'D', colorKey: 'red' }
    case 'untracked': return { letter: 'U', colorKey: 'purple' }
    default: return { letter: '?', colorKey: 'amber' }
  }
}

/** Build a set of all parent dirs that contain changed files */
function buildChangedDirs(gitMap: Map<string, GitInfo>): Set<string> {
  const dirs = new Set<string>()
  for (const path of gitMap.keys()) {
    const parts = path.split('/')
    for (let i = 1; i < parts.length; i++) {
      dirs.add(parts.slice(0, i).join('/'))
    }
  }
  return dirs
}

/** Auto-expand top-level dirs like src/, lib/, app/ on first load */
function getDefaultExpanded(tree: FileEntry[]): Set<string> {
  const expanded = new Set<string>()
  const autoExpand = new Set(['src', 'lib', 'app', 'packages', 'components'])
  for (const entry of tree) {
    if (entry.type === 'directory' && autoExpand.has(entry.name)) {
      expanded.add(entry.path)
    }
  }
  return expanded
}

function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      style={{
        transition: 'transform 0.15s ease',
        transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
        flexShrink: 0,
      }}
    >
      <path d="M3 1.5L7 5L3 8.5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}


// ─────────────────────────────────────────────────────────────────────────────

function TreeNode({
  entry,
  depth,
  gitMap,
  changedDirs,
  expandedDirs,
  onToggleDir,
  onFileClick,
}: {
  entry: FileEntry
  depth: number
  gitMap: Map<string, GitInfo>
  changedDirs: Set<string>
  expandedDirs: Set<string>
  onToggleDir: (path: string) => void
  onFileClick: (path: string) => void
}) {
  const { colors, fonts } = useTheme()
  const isDir = entry.type === 'directory'
  const expanded = expandedDirs.has(entry.path)
  const gitInfo = gitMap.get(entry.path)
  const dirHasChanges = isDir && changedDirs.has(entry.path)

  // File type color
  const ext = (!isDir && entry.name.includes('.')) ? entry.name.split('.').pop()?.toLowerCase() || '' : ''
  const typeColor =
    ['ts', 'tsx'].includes(ext) ? '#3178c6' :
    ['js', 'jsx', 'mjs'].includes(ext) ? '#e8d44d' :
    ['json'].includes(ext) ? '#a8a820' :
    ['css', 'scss', 'less'].includes(ext) ? '#264de4' :
    ['md', 'mdx'].includes(ext) ? '#519aba' :
    ['py'].includes(ext) ? '#3572A5' :
    ['rs'].includes(ext) ? '#dea584' :
    ['go'].includes(ext) ? '#00ADD8' :
    ['html', 'htm'].includes(ext) ? '#e34c26' :
    ['yml', 'yaml'].includes(ext) ? '#cb171e' :
    ['sh', 'bash', 'zsh'].includes(ext) ? '#89e051' :
    null

  const nameColor = gitInfo
    ? colors[getStatusBadge(gitInfo.status).colorKey]
    : isDir
      ? colors.text
      : colors.textSecondary

  return (
    <>
      <div
        onClick={() => { if (isDir) onToggleDir(entry.path); else onFileClick(entry.path) }}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          padding: '1px 8px 1px 0',
          paddingLeft: 10 + depth * 14,
          cursor: 'pointer',
          borderRadius: 3,
          transition: 'background 0.1s ease',
          minHeight: 22,
          position: 'relative',
        }}
        onMouseEnter={e => { e.currentTarget.style.background = colors.bgSurface }}
        onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
      >
        {/* Indent guides */}
        {depth > 0 && Array.from({ length: depth }, (_, i) => (
          <span
            key={i}
            style={{
              position: 'absolute',
              left: 16 + i * 14,
              top: 0,
              bottom: 0,
              width: 1,
              background: colors.border,
              opacity: 0.4,
            }}
          />
        ))}

        {/* Chevron / file dot */}
        {isDir ? (
          <span style={{ width: 14, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, color: colors.textMuted }}>
            <ChevronIcon expanded={expanded} />
          </span>
        ) : (
          <span style={{
            width: 14,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}>
            <span style={{
              width: 5,
              height: 5,
              borderRadius: '50%',
              background: typeColor || colors.textMuted,
              opacity: typeColor ? 0.8 : 0.35,
            }} />
          </span>
        )}

        {/* Name */}
        <span style={{
          fontSize: 12,
          color: nameColor,
          fontFamily: fonts.mono,
          fontWeight: isDir ? 500 : 400,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          flex: 1,
          lineHeight: '20px',
        }}>
          {entry.name}
        </span>

        {/* Git status badge */}
        {gitInfo && (
          <span style={{
            fontSize: 10,
            fontWeight: 700,
            color: colors[getStatusBadge(gitInfo.status).colorKey],
            fontFamily: fonts.mono,
            flexShrink: 0,
            width: 14,
            textAlign: 'center',
          }}>
            {getStatusBadge(gitInfo.status).letter}
          </span>
        )}

        {/* Dir change indicator */}
        {isDir && dirHasChanges && !gitInfo && (
          <span style={{
            width: 5,
            height: 5,
            borderRadius: '50%',
            background: colors.amber,
            opacity: 0.5,
            flexShrink: 0,
          }} />
        )}
      </div>

      {/* Children with collapse animation */}
      {isDir && expanded && entry.children?.map(child => (
        <TreeNode
          key={child.path}
          entry={child}
          depth={depth + 1}
          gitMap={gitMap}
          changedDirs={changedDirs}
          expandedDirs={expandedDirs}
          onToggleDir={onToggleDir}
          onFileClick={onFileClick}
        />
      ))}
    </>
  )
}

export default function FileExplorer({
  cwd,
  collapsed,
  onToggle,
}: {
  cwd?: string
  collapsed: boolean
  onToggle: () => void
}) {
  const { colors, fonts } = useTheme()
  const [tree, setTree] = useState<FileEntry[]>([])
  const [gitMap, setGitMap] = useState<Map<string, GitInfo>>(new Map())
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<string[]>([])
  const [searching, setSearching] = useState(false)
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const searchTimeout = useRef<ReturnType<typeof setTimeout>>()
  const hasAutoExpanded = useRef(false)

  // Precompute set of directories containing changes (avoids O(n) scan per dir)
  const changedDirs = useMemo(() => buildChangedDirs(gitMap), [gitMap])

  // Load file tree
  const loadTree = useCallback(async () => {
    if (!cwd) return
    setLoading(true)
    try {
      const entries = await api.readDir(cwd)
      const result = Array.isArray(entries) ? entries : []
      setTree(result)
      // Auto-expand common top-level dirs on first load
      if (!hasAutoExpanded.current && result.length > 0) {
        hasAutoExpanded.current = true
        setExpandedDirs(getDefaultExpanded(result))
      }
    } catch {
      setTree([])
    }
    setLoading(false)
  }, [cwd])

  // Load git status
  const loadGitStatus = useCallback(async () => {
    if (!cwd) return
    try {
      const result = await api.gitStatus(cwd)
      const map = new Map<string, GitInfo>()
      if (result?.files) {
        for (const f of result.files) {
          const normCwd = cwd.endsWith('/') ? cwd.slice(0, -1) : cwd
          const rel = f.path.startsWith(normCwd + '/') ? f.path.slice(normCwd.length + 1) : f.path
          map.set(rel, { status: f.status })
        }
      }
      setGitMap(map)
    } catch {
      setGitMap(new Map())
    }
  }, [cwd])

  // Reset when cwd changes
  useEffect(() => {
    hasAutoExpanded.current = false
    setExpandedDirs(new Set())
    setTree([])
    setSearchQuery('')
    loadTree()
    loadGitStatus()
  }, [cwd]) // eslint-disable-line react-hooks/exhaustive-deps

  // Refresh git status periodically
  useEffect(() => {
    if (!cwd) return
    const interval = setInterval(loadGitStatus, 5000)
    return () => clearInterval(interval)
  }, [cwd, loadGitStatus])

  const handleToggleDir = useCallback((path: string) => {
    setExpandedDirs(prev => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  // Debounced search
  useEffect(() => {
    if (!searchQuery.trim() || !cwd) {
      setSearchResults([])
      setSearching(false)
      return
    }
    setSearching(true)
    if (searchTimeout.current) clearTimeout(searchTimeout.current)
    searchTimeout.current = setTimeout(async () => {
      try {
        const results = await api.searchFiles(cwd, searchQuery, 20)
        setSearchResults(results)
      } catch {
        setSearchResults([])
      }
      setSearching(false)
    }, 150)
  }, [searchQuery, cwd])

  const gitChangeCount = gitMap.size

  if (collapsed) {
    return (
      <div
        onClick={onToggle}
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
        Explorer
      </div>
    )
  }

  return (
    <div style={{
      background: colors.bgOverlay,
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
      flex: 1,
    }}>
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 0 }}>
      {/* Search */}
      <div style={{ padding: '6px 8px', flexShrink: 0, borderBottom: `1px solid ${colors.border}` }}>
        <div style={{ position: 'relative' }}>
          <input
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="Search files..."
            style={{
              width: '100%',
              background: colors.bgSurface,
              border: `1px solid ${colors.borderMuted}`,
              borderRadius: 5,
              color: colors.text,
              fontSize: 11,
              fontFamily: fonts.mono,
              padding: '5px 8px 5px 24px',
              outline: 'none',
              boxSizing: 'border-box',
              transition: 'border-color 0.15s ease',
            }}
            onFocus={e => { e.currentTarget.style.borderColor = colors.blue }}
            onBlur={e => { e.currentTarget.style.borderColor = colors.borderMuted }}
          />
          {/* Search icon */}
          <svg
            width="12" height="12" viewBox="0 0 16 16"
            style={{ position: 'absolute', left: 7, top: '50%', transform: 'translateY(-50%)', opacity: 0.4 }}
          >
            <circle cx="6.5" cy="6.5" r="5" stroke={colors.textMuted} strokeWidth="1.5" fill="none" />
            <line x1="10" y1="10" x2="14" y2="14" stroke={colors.textMuted} strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          {/* Change count badge */}
          {gitChangeCount > 0 && !searchQuery && (
            <span style={{
              position: 'absolute',
              right: 6,
              top: '50%',
              transform: 'translateY(-50%)',
              fontSize: 9,
              fontFamily: fonts.mono,
              background: `${colors.amber}18`,
              color: colors.amber,
              padding: '1px 5px',
              borderRadius: 8,
              fontWeight: 600,
            }}>
              {gitChangeCount} changed
            </span>
          )}
        </div>
      </div>

      {/* File tree or search results */}
      <div style={{
        flex: 1,
        overflow: 'auto',
        padding: '4px 0',
        // Smooth scrollbar
        scrollbarWidth: 'thin',
        scrollbarColor: `${colors.border} transparent`,
      }}>
        {loading && tree.length === 0 && (
          <div style={{ padding: '24px 12px', fontSize: 12, color: colors.textMuted, textAlign: 'center' }}>
            Loading...
          </div>
        )}

        {!cwd && (
          <div style={{ padding: '24px 12px', fontSize: 12, color: colors.textMuted, textAlign: 'center' }}>
            No folder open
          </div>
        )}

        {searchQuery.trim() ? (
          /* Search results */
          <>
            {searching && searchResults.length === 0 && (
              <div style={{ padding: '16px', fontSize: 11, color: colors.textMuted, textAlign: 'center' }}>
                Searching...
              </div>
            )}
            {searchResults.map(path => {
              const name = path.split('/').pop() || path
              const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
              const gitInfo = gitMap.get(path)
              return (
                <div
                  key={path}
                  onClick={() => setSelectedFile(path)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '3px 10px',
                    borderRadius: 3,
                    transition: 'background 0.1s ease',
                    cursor: 'pointer',
                    minHeight: 22,
                  }}
                  onMouseEnter={e => { e.currentTarget.style.background = colors.bgSurface }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
                >
                  <span style={{
                    fontSize: 12,
                    color: gitInfo ? colors[getStatusBadge(gitInfo.status).colorKey] : colors.text,
                    fontFamily: fonts.mono,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    fontWeight: 500,
                  }}>
                    {name}
                  </span>
                  {dir && (
                    <span style={{
                      fontSize: 10,
                      color: colors.textMuted,
                      fontFamily: fonts.mono,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      flex: 1,
                      textAlign: 'right',
                    }}>
                      {dir}
                    </span>
                  )}
                  {gitInfo && (
                    <span style={{
                      fontSize: 10,
                      fontWeight: 700,
                      color: colors[getStatusBadge(gitInfo.status).colorKey],
                      fontFamily: fonts.mono,
                      flexShrink: 0,
                    }}>
                      {getStatusBadge(gitInfo.status).letter}
                    </span>
                  )}
                </div>
              )
            })}
            {!searching && searchQuery.trim() && searchResults.length === 0 && (
              <div style={{ padding: '16px', fontSize: 11, color: colors.textMuted, textAlign: 'center' }}>
                No files match "{searchQuery}"
              </div>
            )}
          </>
        ) : (
          /* Tree view */
          cwd && tree.map(entry => (
            <TreeNode
              key={entry.path}
              entry={entry}
              depth={0}
              gitMap={gitMap}
              changedDirs={changedDirs}
              expandedDirs={expandedDirs}
              onToggleDir={handleToggleDir}
              onFileClick={setSelectedFile}
            />
          ))
        )}
      </div>

      {/* Footer with refresh */}
      {cwd && !searchQuery && (
        <div style={{
          padding: '4px 10px',
          borderTop: `1px solid ${colors.border}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexShrink: 0,
        }}>
          <span style={{ fontSize: 10, color: colors.textMuted, fontFamily: fonts.mono }}>
            {cwd.split('/').pop()}
          </span>
          <span
            onClick={() => { loadTree(); loadGitStatus() }}
            style={{ cursor: 'pointer', fontSize: 11, color: colors.textMuted, transition: 'color 0.15s ease' }}
            title="Refresh"
            onMouseEnter={e => { e.currentTarget.style.color = colors.text }}
            onMouseLeave={e => { e.currentTarget.style.color = colors.textMuted }}
          >
            ↻
          </span>
        </div>
      )}
    </div>
    </div>
    {selectedFile && cwd && (
      <DiffView filePath={selectedFile} cwd={cwd} onClose={() => setSelectedFile(null)} />
    )}
  </div>
  )
}
