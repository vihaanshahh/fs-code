import React, { useMemo } from 'react'
import type { TrackedFile, FileOperationType } from '../../../shared/types'
import { useTheme } from '../../ThemeContext'

const opLabel: Record<FileOperationType, string> = {
  read: 'R',
  write: 'W',
  create: 'C',
  execute: 'X',
}

// ── Helpers ─────────────────────────────────────────────────────────

function parentDir(path: string): string {
  const parts = path.split('/')
  if (parts.length <= 1) return '.'
  return parts.slice(0, -1).join('/')
}

/** Shorten a directory path: keep last 2 segments, collapse the rest */
function shortenDir(dir: string): string {
  if (dir === '.' || dir === '/') return dir
  const parts = dir.split('/')
  if (parts.length <= 2) return dir
  return '.../' + parts.slice(-2).join('/')
}

interface FolderGroup {
  dir: string
  shortDir: string
  files: TrackedFile[]
}

function groupByFolder(files: TrackedFile[]): FolderGroup[] {
  const map = new Map<string, TrackedFile[]>()
  for (const file of files) {
    const dir = parentDir(file.path)
    if (!map.has(dir)) map.set(dir, [])
    map.get(dir)!.push(file)
  }
  // Sort groups: most recently active first
  return Array.from(map.entries())
    .map(([dir, files]) => ({
      dir,
      shortDir: shortenDir(dir),
      files: files.sort((a, b) => b.lastSeen - a.lastSeen),
    }))
    .sort((a, b) => {
      const aMax = Math.max(...a.files.map(f => f.lastSeen))
      const bMax = Math.max(...b.files.map(f => f.lastSeen))
      return bMax - aMax
    })
}

// ── Sub-components ──────────────────────────────────────────────────

function FileRow({ file, onClick }: { file: TrackedFile; onClick: () => void }) {
  const { colors, fonts } = useTheme()
  const opTypes = [...new Set(file.operations.map(o => o.type))]
  const elapsed = Date.now() - file.lastSeen
  const isRecent = elapsed < 5000

  // Count write/create operations for the +/- badge
  const editOps = file.operations.filter(o => o.type === 'write' || o.type === 'create')

  const opDotColor: Record<FileOperationType, string> = {
    read: colors.dotRead,
    write: colors.dotWrite,
    create: colors.dotCreate,
    execute: colors.dotExecute,
  }

  return (
    <div
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '5px 12px 5px 24px',
        cursor: 'pointer',
        borderRadius: 6,
        transition: 'background 0.1s ease',
        animation: isRecent ? 'fadeSlideIn 0.3s ease' : 'none',
      }}
      onMouseEnter={e => { e.currentTarget.style.background = `${colors.bgSurface}` }}
      onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
    >
      {/* Operation dots */}
      <div style={{ display: 'flex', gap: 3 }}>
        {opTypes.map(op => (
          <span
            key={op}
            title={op}
            style={{
              width: 7,
              height: 7,
              borderRadius: '50%',
              background: opDotColor[op],
              flexShrink: 0,
            }}
          />
        ))}
      </div>

      {/* File name */}
      <span style={{
        fontSize: 12,
        color: colors.text,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        flex: 1,
        fontFamily: fonts.mono,
      }}>
        {file.basename}
      </span>

      {/* Edit count badge */}
      {editOps.length > 0 && (
        <span style={{
          fontSize: 10,
          color: colors.diffAddText,
          fontFamily: fonts.mono,
          fontWeight: 600,
        }}>
          {editOps.length}x
        </span>
      )}

      {/* Operation count */}
      <span style={{
        fontSize: 10,
        color: colors.textMuted,
        fontFamily: fonts.mono,
      }}>
        {file.operations.length}
      </span>
    </div>
  )
}

function FolderDivider({ label, fileCount }: { label: string; fileCount: number }) {
  const { colors, fonts } = useTheme()
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      padding: '8px 12px 4px',
      userSelect: 'none',
    }}>
      {/* Folder icon (VS Code style) */}
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
        <path d="M1.5 2h4.667l1.333 2H14.5v10h-13V2z" stroke={colors.textMuted} strokeWidth="1.2" fill="none" />
      </svg>
      <span style={{
        fontSize: 11,
        color: colors.textSecondary,
        fontFamily: fonts.mono,
        fontWeight: 600,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        flex: 1,
      }}>
        {label}
      </span>
      <span style={{
        fontSize: 9,
        color: colors.textMuted,
        fontFamily: fonts.mono,
      }}>
        {fileCount}
      </span>
    </div>
  )
}

// ── Main component ──────────────────────────────────────────────────

export default function FileActivitySidebar({
  files,
  collapsed,
  loading,
  onToggle,
  onFileClick,
  agentName,
}: {
  files: TrackedFile[]
  collapsed: boolean
  loading?: boolean
  onToggle: () => void
  onFileClick: (file: TrackedFile) => void
  agentName?: string
}) {
  const { colors, fonts } = useTheme()

  const opDotColor: Record<FileOperationType, string> = useMemo(() => ({
    read: colors.dotRead,
    write: colors.dotWrite,
    create: colors.dotCreate,
    execute: colors.dotExecute,
  }), [colors])

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
        Files ({files.length})
      </div>
    )
  }

  const groups = groupByFolder(files)
  const singleGroup = groups.length === 1

  return (
    <div style={{
      width: 280,
      borderLeft: `1px solid ${colors.border}`,
      background: colors.bgOverlay,
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
      flex: 1,
      minHeight: 0,
    }}>
      {/* Header */}
      <div style={{
        padding: '10px 12px',
        borderBottom: `1px solid ${colors.border}`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        userSelect: 'none',
      }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5 }}>
          {agentName ? `${agentName} Files` : 'File Activity'}
        </span>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ fontSize: 10, color: colors.textMuted, fontFamily: fonts.mono }}>
            {files.length} files
          </span>
          <span
            onClick={onToggle}
            style={{ cursor: 'pointer', fontSize: 14, color: colors.textMuted }}
            title="Collapse sidebar"
          >
            {'\u00BB'}
          </span>
        </div>
      </div>

      {/* Legend */}
      <div style={{
        padding: '6px 12px',
        display: 'flex',
        gap: 10,
        borderBottom: `1px solid ${colors.border}`,
      }}>
        {(['read', 'write', 'create', 'execute'] as FileOperationType[]).map(op => (
          <div key={op} style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 10, color: colors.textMuted }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: opDotColor[op] }} />
            {opLabel[op]}
          </div>
        ))}
      </div>

      {/* File list grouped by folder */}
      <div style={{ flex: 1, overflow: 'auto', padding: '4px 0' }}>
        {files.length === 0 && (
          <div style={{ padding: '20px 12px', fontSize: 12, color: colors.textMuted, textAlign: 'center' }}>
            {loading ? (
              <span style={{ animation: 'pulse 1.5s infinite' }}>Scanning files...</span>
            ) : (
              'No files touched yet'
            )}
          </div>
        )}

        {groups.map((group, gi) => (
          <div key={group.dir}>
            {/* Folder divider — skip if there's only one group with a trivial path */}
            {!singleGroup && (
              <FolderDivider label={group.shortDir} fileCount={group.files.length} />
            )}

            {/* Files in this folder */}
            {group.files.map(file => (
              <FileRow key={file.path} file={file} onClick={() => onFileClick(file)} />
            ))}

            {/* Separator between groups */}
            {!singleGroup && gi < groups.length - 1 && (
              <div style={{
                margin: '4px 12px',
                height: 1,
                background: colors.border,
              }} />
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
