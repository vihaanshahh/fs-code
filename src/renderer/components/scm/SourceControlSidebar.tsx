import React, { useState, useCallback } from 'react'
import { useTheme } from '../../ThemeContext'
import { useSourceControl } from '../../hooks/useSourceControl'
import ContextMenu, { type ContextMenuItem } from './ContextMenu'
import ConfirmDialog from '../shared/ConfirmDialog'
import DiffView from './DiffView'
import type { GitFileStatus } from '../../../shared/types'

// ── Helpers ─────────────────────────────────────────────────────────

function getStatusBadge(file: GitFileStatus): { letter: string; color: string } {
  const status = file.category === 'staged' ? file.indexStatus : file.workTreeStatus
  switch (status) {
    case 'M': return { letter: 'M', color: '' } // amber — set in component
    case 'A': return { letter: 'A', color: '' } // green
    case 'D': return { letter: 'D', color: '' } // red
    case '?': return { letter: 'U', color: '' } // purple (untracked)
    case 'R': return { letter: 'R', color: '' } // blue
    default: return { letter: status || '?', color: '' }
  }
}

function parentPath(path: string): string {
  const parts = path.split('/')
  if (parts.length <= 1) return ''
  return parts.slice(-2, -1)[0] + '/'
}

// ── File Row ────────────────────────────────────────────────────────

function ChangeFileRow({
  file,
  category,
  onStage,
  onUnstage,
  onDiscard,
  onClick,
  onContextMenu,
}: {
  file: GitFileStatus
  category: 'staged' | 'unstaged' | 'untracked'
  onStage?: () => void
  onUnstage?: () => void
  onDiscard?: () => void
  onClick: () => void
  onContextMenu: (e: React.MouseEvent) => void
}) {
  const { colors, fonts } = useTheme()
  const status = category === 'staged' ? file.indexStatus : file.workTreeStatus

  const statusColor =
    status === 'M' ? colors.amber :
    status === 'A' ? colors.green :
    status === 'D' ? colors.red :
    status === '?' ? colors.purple :
    colors.textMuted

  const statusLetter =
    status === 'M' ? 'M' :
    status === 'A' ? 'A' :
    status === 'D' ? 'D' :
    status === '?' ? 'U' : status

  return (
    <div
      onClick={onClick}
      onContextMenu={onContextMenu}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 8px 4px 16px',
        cursor: 'pointer',
        borderRadius: 4,
        transition: 'background 0.1s ease',
        group: 'row',
      }}
      onMouseEnter={e => { e.currentTarget.style.background = `${colors.bgSurface}` }}
      onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
    >
      {/* Status badge */}
      <span style={{
        fontSize: 11,
        fontWeight: 700,
        color: statusColor,
        width: 14,
        textAlign: 'center',
        flexShrink: 0,
        fontFamily: fonts.mono,
      }}>
        {statusLetter}
      </span>

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

      {/* Parent dir hint */}
      <span style={{
        fontSize: 10,
        color: colors.textMuted,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        maxWidth: 80,
        fontFamily: fonts.mono,
      }}>
        {parentPath(file.path)}
      </span>

      {/* Action buttons */}
      <div style={{ display: 'flex', gap: 2, flexShrink: 0 }}
        onClick={e => e.stopPropagation()}
      >
        {onDiscard && (
          <ActionButton
            title="Discard Changes"
            onClick={onDiscard}
            color={colors.textMuted}
            hoverColor={colors.red}
          >
            ↩
          </ActionButton>
        )}
        {onStage && (
          <ActionButton
            title="Stage"
            onClick={onStage}
            color={colors.textMuted}
            hoverColor={colors.green}
          >
            +
          </ActionButton>
        )}
        {onUnstage && (
          <ActionButton
            title="Unstage"
            onClick={onUnstage}
            color={colors.textMuted}
            hoverColor={colors.amber}
          >
            −
          </ActionButton>
        )}
      </div>
    </div>
  )
}

function ActionButton({
  children,
  title,
  onClick,
  color,
  hoverColor,
}: {
  children: React.ReactNode
  title: string
  onClick: () => void
  color: string
  hoverColor: string
}) {
  return (
    <span
      title={title}
      onClick={onClick}
      style={{
        width: 20,
        height: 20,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 4,
        fontSize: 14,
        fontWeight: 700,
        cursor: 'pointer',
        color,
        transition: 'color 0.1s ease, background 0.1s ease',
      }}
      onMouseEnter={e => {
        e.currentTarget.style.color = hoverColor
        e.currentTarget.style.background = `${hoverColor}18`
      }}
      onMouseLeave={e => {
        e.currentTarget.style.color = color
        e.currentTarget.style.background = 'transparent'
      }}
    >
      {children}
    </span>
  )
}

// ── Section header ──────────────────────────────────────────────────

function SectionHeader({
  label,
  count,
  action,
  actionTitle,
  onAction,
  collapsed,
  onToggle,
}: {
  label: string
  count: number
  action?: string
  actionTitle?: string
  onAction?: () => void
  collapsed: boolean
  onToggle: () => void
}) {
  const { colors, fonts } = useTheme()
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '6px 8px',
        userSelect: 'none',
        cursor: 'pointer',
      }}
      onClick={onToggle}
    >
      <span style={{ fontSize: 10, color: colors.textMuted, transform: collapsed ? 'rotate(-90deg)' : 'rotate(0)', transition: 'transform 0.15s ease' }}>
        ▾
      </span>
      <span style={{
        fontSize: 11,
        fontWeight: 600,
        color: colors.textSecondary,
        textTransform: 'uppercase',
        letterSpacing: 0.5,
        flex: 1,
      }}>
        {label}
      </span>
      <span style={{ fontSize: 10, color: colors.textMuted, fontFamily: fonts.mono }}>
        {count}
      </span>
      {action && onAction && (
        <span
          title={actionTitle}
          onClick={e => { e.stopPropagation(); onAction() }}
          style={{
            fontSize: 14,
            fontWeight: 700,
            color: colors.textMuted,
            cursor: 'pointer',
            width: 20,
            height: 20,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 4,
            transition: 'color 0.1s ease',
          }}
          onMouseEnter={e => { e.currentTarget.style.color = colors.text }}
          onMouseLeave={e => { e.currentTarget.style.color = colors.textMuted }}
        >
          {action}
        </span>
      )}
    </div>
  )
}

// ── Main component ──────────────────────────────────────────────────

export default function SourceControlSidebar({
  cwd,
  collapsed,
  onToggle,
}: {
  cwd?: string
  collapsed: boolean
  onToggle: () => void
}) {
  const { colors, fonts } = useTheme()
  const scm = useSourceControl(cwd, !collapsed)

  const [commitMessage, setCommitMessage] = useState('')
  const [isCommitting, setIsCommitting] = useState(false)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; file: GitFileStatus; category: 'staged' | 'unstaged' | 'untracked' } | null>(null)
  const [discardConfirm, setDiscardConfirm] = useState<GitFileStatus | null>(null)
  const [selectedFile, setSelectedFile] = useState<string | null>(null)

  // Section collapse state
  const [stagedCollapsed, setStagedCollapsed] = useState(false)
  const [changesCollapsed, setChangesCollapsed] = useState(false)
  const [untrackedCollapsed, setUntrackedCollapsed] = useState(false)

  const handleCommit = useCallback(async () => {
    if (!commitMessage.trim() || scm.stagedFiles.length === 0) return
    setIsCommitting(true)
    const result = await scm.commit(commitMessage)
    setIsCommitting(false)
    if (result.success) {
      setCommitMessage('')
    }
  }, [commitMessage, scm])

  const handleContextMenu = useCallback((e: React.MouseEvent, file: GitFileStatus, category: 'staged' | 'unstaged' | 'untracked') => {
    e.preventDefault()
    setContextMenu({ x: e.clientX, y: e.clientY, file, category })
  }, [])

  const handleDiscard = useCallback((file: GitFileStatus) => {
    setDiscardConfirm(file)
  }, [])

  const confirmDiscard = useCallback(async () => {
    if (discardConfirm) {
      await scm.discard(discardConfirm.path)
      setDiscardConfirm(null)
    }
  }, [discardConfirm, scm])

  // Build context menu items
  const contextMenuItems: ContextMenuItem[] = contextMenu ? (() => {
    const items: ContextMenuItem[] = []
    const { file, category } = contextMenu

    if (category === 'staged') {
      items.push({ label: 'Unstage File', onClick: () => scm.unstage(file.path) })
    } else {
      items.push({ label: 'Stage File', onClick: () => scm.stage(file.path) })
    }

    items.push({ separator: true, label: '', onClick: () => {} })
    items.push({
      label: 'Discard Changes',
      onClick: () => handleDiscard(file),
      danger: true,
    })

    return items
  })() : []

  // Collapsed state
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
        SCM ({scm.totalChanges})
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
          Source Control
        </span>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span
            onClick={scm.refresh}
            style={{ cursor: 'pointer', fontSize: 12, color: colors.textMuted }}
            title="Refresh"
          >
            ↻
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

      {/* Commit box */}
      <div style={{
        padding: '8px 10px',
        borderBottom: `1px solid ${colors.border}`,
      }}>
        <textarea
          value={commitMessage}
          onChange={e => setCommitMessage(e.target.value)}
          placeholder="Commit message"
          style={{
            width: '100%',
            minHeight: 32,
            maxHeight: 80,
            resize: 'vertical',
            background: colors.bgSurface,
            border: `1px solid ${colors.borderMuted}`,
            borderRadius: 6,
            color: colors.text,
            fontSize: 12,
            fontFamily: fonts.mono,
            padding: '6px 8px',
            outline: 'none',
            boxSizing: 'border-box',
          }}
          onFocus={e => { e.currentTarget.style.borderColor = colors.blue }}
          onBlur={e => { e.currentTarget.style.borderColor = colors.borderMuted }}
          onKeyDown={e => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault()
              handleCommit()
            }
          }}
        />
        <button
          onClick={handleCommit}
          disabled={!commitMessage.trim() || scm.stagedFiles.length === 0 || isCommitting}
          style={{
            width: '100%',
            marginTop: 6,
            padding: '5px 0',
            fontSize: 12,
            fontWeight: 600,
            background: (!commitMessage.trim() || scm.stagedFiles.length === 0) ? colors.borderMuted : colors.blue,
            color: '#fff',
            border: 'none',
            borderRadius: 6,
            cursor: (!commitMessage.trim() || scm.stagedFiles.length === 0) ? 'not-allowed' : 'pointer',
            opacity: (!commitMessage.trim() || scm.stagedFiles.length === 0) ? 0.5 : 1,
            transition: 'opacity 0.15s ease',
          }}
        >
          {isCommitting ? 'Committing...' : `Commit${scm.stagedFiles.length > 0 ? ` (${scm.stagedFiles.length})` : ''}`}
        </button>
      </div>

      {/* File list */}
      <div style={{ flex: 1, overflow: 'auto', padding: '2px 0' }}>
        {scm.totalChanges === 0 && (
          <div style={{ padding: '20px 12px', fontSize: 12, color: colors.textMuted, textAlign: 'center' }}>
            {scm.loading ? (
              <span style={{ animation: 'pulse 1.5s infinite' }}>Scanning...</span>
            ) : (
              'No changes detected'
            )}
          </div>
        )}

        {/* Staged Changes */}
        {scm.stagedFiles.length > 0 && (
          <div>
            <SectionHeader
              label="Staged Changes"
              count={scm.stagedFiles.length}
              action="−"
              actionTitle="Unstage All"
              onAction={scm.unstageAll}
              collapsed={stagedCollapsed}
              onToggle={() => setStagedCollapsed(v => !v)}
            />
            {!stagedCollapsed && scm.stagedFiles.map(file => (
              <ChangeFileRow
                key={`staged-${file.path}`}
                file={file}
                category="staged"
                onUnstage={() => scm.unstage(file.path)}
                onClick={() => setSelectedFile(selectedFile === file.path ? null : file.path)}
                onContextMenu={e => handleContextMenu(e, file, 'staged')}
              />
            ))}
          </div>
        )}

        {/* Changes (unstaged) */}
        {scm.unstagedFiles.length > 0 && (
          <div>
            <SectionHeader
              label="Changes"
              count={scm.unstagedFiles.length}
              action="+"
              actionTitle="Stage All"
              onAction={() => {
                // Stage only unstaged (not untracked)
                for (const f of scm.unstagedFiles) scm.stage(f.path)
              }}
              collapsed={changesCollapsed}
              onToggle={() => setChangesCollapsed(v => !v)}
            />
            {!changesCollapsed && scm.unstagedFiles.map(file => (
              <ChangeFileRow
                key={`unstaged-${file.path}`}
                file={file}
                category="unstaged"
                onStage={() => scm.stage(file.path)}
                onDiscard={() => handleDiscard(file)}
                onClick={() => setSelectedFile(selectedFile === file.path ? null : file.path)}
                onContextMenu={e => handleContextMenu(e, file, 'unstaged')}
              />
            ))}
          </div>
        )}

        {/* Untracked */}
        {scm.untrackedFiles.length > 0 && (
          <div>
            <SectionHeader
              label="Untracked"
              count={scm.untrackedFiles.length}
              action="+"
              actionTitle="Stage All Untracked"
              onAction={() => {
                for (const f of scm.untrackedFiles) scm.stage(f.path)
              }}
              collapsed={untrackedCollapsed}
              onToggle={() => setUntrackedCollapsed(v => !v)}
            />
            {!untrackedCollapsed && scm.untrackedFiles.map(file => (
              <ChangeFileRow
                key={`untracked-${file.path}`}
                file={file}
                category="untracked"
                onStage={() => scm.stage(file.path)}
                onDiscard={() => handleDiscard(file)}
                onClick={() => setSelectedFile(selectedFile === file.path ? null : file.path)}
                onContextMenu={e => handleContextMenu(e, file, 'untracked')}
              />
            ))}
          </div>
        )}
      </div>

      {/* Inline diff view */}
      {selectedFile && cwd && (
        <DiffView
          filePath={selectedFile}
          cwd={cwd}
          onClose={() => setSelectedFile(null)}
        />
      )}

      {/* Context menu */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenuItems}
          onClose={() => setContextMenu(null)}
        />
      )}

      {/* Discard confirmation */}
      {discardConfirm && (
        <ConfirmDialog
          title="Discard Changes"
          message={`Are you sure you want to discard changes to "${discardConfirm.basename}"? This cannot be undone.`}
          confirmLabel="Discard"
          danger
          onConfirm={confirmDiscard}
          onCancel={() => setDiscardConfirm(null)}
        />
      )}
    </div>
  )
}
