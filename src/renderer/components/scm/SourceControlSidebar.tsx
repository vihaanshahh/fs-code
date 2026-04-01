import React, { useState, useCallback, useEffect } from 'react'
import { useTheme } from '../../ThemeContext'
import { useSourceControl } from '../../hooks/useSourceControl'
import ContextMenu, { type ContextMenuItem } from './ContextMenu'
import ConfirmDialog from '../shared/ConfirmDialog'
import { api } from '../../lib/api'
import {
  computeLineDiff, splitIntoHunks, newFileDiffLines, deletedFileDiffLines, countDiffLines,
  type DiffLine,
} from '../shared/diff-utils'
import { DiffHunkHeader, DiffLineRow, ExpandableContext } from '../shared/DiffDisplay'
import type { GitFileStatus } from '../../../shared/types'

// ── Helpers ─────────────────────────────────────────────────────────

type GitDiffStatus = 'untracked' | 'modified' | 'added' | 'deleted' | 'unchanged' | 'error'

function parentPath(path: string): string {
  const parts = path.split('/')
  if (parts.length <= 1) return ''
  return parts.slice(-2, -1)[0] + '/'
}

// ── Inline Diff (per-file accordion) ────────────────────────────────

function InlineDiff({ filePath, cwd }: { filePath: string; cwd: string }) {
  const { colors, fonts } = useTheme()

  const [gitData, setGitData] = useState<{
    baseContent: string | null
    currentContent: string
    status: GitDiffStatus
  } | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)

    api.gitDiff(filePath, cwd)
      .then((data: any) => {
        if (cancelled) return
        if (data && typeof data === 'object' && typeof data.status === 'string') {
          setGitData({ ...data, currentContent: data.currentContent ?? '' })
        } else {
          return api.readFile(filePath, cwd).then((res: any) => {
            if (!cancelled) setGitData({ baseContent: null, currentContent: res?.content ?? '', status: 'untracked' })
          })
        }
      })
      .catch(() => {
        if (!cancelled) setGitData({ baseContent: null, currentContent: '', status: 'error' })
      })
      .finally(() => { if (!cancelled) setLoading(false) })

    return () => { cancelled = true }
  }, [filePath, cwd])

  if (loading) {
    return (
      <div style={{ padding: '8px 16px', fontSize: 11, color: colors.textMuted }}>
        Loading...
      </div>
    )
  }

  if (!gitData || gitData.status === 'error') {
    return (
      <div style={{ padding: '8px 16px', fontSize: 11, color: colors.textMuted }}>
        Could not load diff
      </div>
    )
  }

  if (gitData.status === 'unchanged') {
    return (
      <div style={{ padding: '8px 16px', fontSize: 11, color: colors.textMuted }}>
        No changes
      </div>
    )
  }

  const diffLines: DiffLine[] = (() => {
    if (gitData.status === 'untracked' || gitData.status === 'added') {
      return newFileDiffLines(gitData.currentContent)
    }
    if (gitData.status === 'deleted' && gitData.baseContent) {
      return deletedFileDiffLines(gitData.baseContent)
    }
    if (gitData.baseContent !== null) {
      return computeLineDiff(gitData.baseContent, gitData.currentContent)
    }
    return newFileDiffLines(gitData.currentContent)
  })()

  // 8 lines of context so you see the surrounding code, not just isolated changes
  const hunks = splitIntoHunks(diffLines, 8)

  // Pre-compute hidden lines between hunks for expandable gaps
  const gapsBetweenHunks: { count: number; lines: DiffLine[] }[] = []
  for (let hi = 1; hi < hunks.length; hi++) {
    const prevHunk = hunks[hi - 1]
    const currHunk = hunks[hi]
    const prevEnd = prevHunk.lines[prevHunk.lines.length - 1]
    const currStart = currHunk.lines[0]

    // Find the range of diffLines between the two hunks
    const prevEndIdx = diffLines.findIndex(l =>
      l.oldNum === prevEnd?.oldNum && l.newNum === prevEnd?.newNum && l.content === prevEnd?.content
    )
    const currStartIdx = diffLines.findIndex(l =>
      l.oldNum === currStart?.oldNum && l.newNum === currStart?.newNum && l.content === currStart?.content
    )

    if (prevEndIdx >= 0 && currStartIdx > prevEndIdx + 1) {
      gapsBetweenHunks.push({
        count: currStartIdx - prevEndIdx - 1,
        lines: diffLines.slice(prevEndIdx + 1, currStartIdx),
      })
    } else {
      const count = (currStart?.oldNum ?? currHunk.oldStart) -
        (prevEnd?.oldNum ?? 0) - 1
      gapsBetweenHunks.push({ count: Math.max(0, count), lines: [] })
    }
  }

  return (
    <div style={{
      borderTop: `1px solid ${colors.border}`,
      borderBottom: `1px solid ${colors.border}`,
      background: colors.bg,
      maxHeight: 500,
      overflow: 'auto',
    }}>
      {hunks.length === 0 && diffLines.length > 0 ? (
        diffLines.map((line, i) => <DiffLineRow key={i} line={line} />)
      ) : hunks.length === 0 ? (
        <div style={{ padding: '8px 16px', color: colors.textMuted, fontSize: 11 }}>Empty file</div>
      ) : (
        hunks.map((hunk, hi) => (
          <div key={hi}>
            {hi > 0 && gapsBetweenHunks[hi - 1] && (
              <ExpandableContext
                count={gapsBetweenHunks[hi - 1].count}
                hiddenLines={gapsBetweenHunks[hi - 1].lines}
              />
            )}
            <DiffHunkHeader
              text={`@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`}
            />
            {hunk.lines.map((line, li) => <DiffLineRow key={li} line={line} />)}
          </div>
        ))
      )}
    </div>
  )
}

// ── Diff stats loader (async +/- counts per file) ──────────────────

function useDiffStats(filePath: string, cwd: string | undefined, enabled: boolean) {
  const [stats, setStats] = useState<{ add: number; remove: number } | null>(null)

  useEffect(() => {
    if (!enabled || !cwd) { setStats(null); return }

    let cancelled = false
    api.gitDiff(filePath, cwd)
      .then((data: any) => {
        if (cancelled) return
        if (!data || typeof data !== 'object' || typeof data.status !== 'string') {
          setStats(null)
          return
        }
        const { baseContent, currentContent, status } = data as {
          baseContent: string | null; currentContent: string; status: GitDiffStatus
        }

        let diffLines: DiffLine[]
        if (status === 'untracked' || status === 'added') {
          diffLines = newFileDiffLines(currentContent)
        } else if (status === 'deleted' && baseContent) {
          diffLines = deletedFileDiffLines(baseContent)
        } else if (baseContent !== null) {
          diffLines = computeLineDiff(baseContent, currentContent)
        } else {
          diffLines = newFileDiffLines(currentContent)
        }

        if (!cancelled) setStats(countDiffLines(diffLines))
      })
      .catch(() => { if (!cancelled) setStats(null) })

    return () => { cancelled = true }
  }, [filePath, cwd, enabled])

  return stats
}

// ── File Row ────────────────────────────────────────────────────────

function ChangeFileRow({
  file,
  category,
  expanded,
  cwd,
  onStage,
  onUnstage,
  onDiscard,
  onToggleExpand,
  onContextMenu,
}: {
  file: GitFileStatus
  category: 'staged' | 'unstaged' | 'untracked'
  expanded: boolean
  cwd?: string
  onStage?: () => void
  onUnstage?: () => void
  onDiscard?: () => void
  onToggleExpand: () => void
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

  // Load diff stats for +/- badge
  const stats = useDiffStats(file.path, cwd, true)

  return (
    <div>
      <div
        onClick={onToggleExpand}
        onContextMenu={onContextMenu}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '4px 8px 4px 12px',
          cursor: 'pointer',
          borderRadius: 4,
          transition: 'background 0.1s ease',
          background: expanded ? `${colors.bgSurface}` : 'transparent',
        }}
        onMouseEnter={e => { if (!expanded) e.currentTarget.style.background = `${colors.bgSurface}` }}
        onMouseLeave={e => { if (!expanded) e.currentTarget.style.background = 'transparent' }}
      >
        {/* Expand chevron */}
        <span style={{
          fontSize: 9,
          color: colors.textMuted,
          transform: expanded ? 'rotate(0)' : 'rotate(-90deg)',
          transition: 'transform 0.15s ease',
          flexShrink: 0,
          width: 10,
          textAlign: 'center',
        }}>
          ▾
        </span>

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
          maxWidth: 60,
          fontFamily: fonts.mono,
        }}>
          {parentPath(file.path)}
        </span>

        {/* +/- line counts */}
        {stats && (stats.add > 0 || stats.remove > 0) && (
          <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexShrink: 0 }}>
            {stats.add > 0 && (
              <span style={{ fontSize: 10, fontWeight: 600, color: colors.diffAddText, fontFamily: fonts.mono }}>
                +{stats.add}
              </span>
            )}
            {stats.remove > 0 && (
              <span style={{ fontSize: 10, fontWeight: 600, color: colors.diffRemoveText, fontFamily: fonts.mono }}>
                -{stats.remove}
              </span>
            )}
          </div>
        )}

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

      {/* Inline diff (expanded) */}
      {expanded && cwd && (
        <InlineDiff filePath={file.path} cwd={cwd} />
      )}
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
  onExpandAll,
  onCollapseAll,
  hasExpanded,
}: {
  label: string
  count: number
  action?: string
  actionTitle?: string
  onAction?: () => void
  collapsed: boolean
  onToggle: () => void
  onExpandAll: () => void
  onCollapseAll: () => void
  hasExpanded: boolean
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

      {/* Expand/collapse all diffs in this section */}
      {!collapsed && count > 0 && (
        <span
          title={hasExpanded ? 'Collapse all diffs' : 'Expand all diffs'}
          onClick={e => { e.stopPropagation(); hasExpanded ? onCollapseAll() : onExpandAll() }}
          style={{
            fontSize: 11,
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
          {hasExpanded ? '⊟' : '⊞'}
        </span>
      )}

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

  // Section collapse state
  const [stagedCollapsed, setStagedCollapsed] = useState(false)
  const [changesCollapsed, setChangesCollapsed] = useState(false)
  const [untrackedCollapsed, setUntrackedCollapsed] = useState(false)

  // Track which files have their diff expanded (by path)
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set())

  const toggleExpand = useCallback((path: string) => {
    setExpandedFiles(prev => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const expandAll = useCallback((files: GitFileStatus[]) => {
    setExpandedFiles(prev => {
      const next = new Set(prev)
      for (const f of files) next.add(f.path)
      return next
    })
  }, [])

  const collapseAll = useCallback((files: GitFileStatus[]) => {
    setExpandedFiles(prev => {
      const next = new Set(prev)
      for (const f of files) next.delete(f.path)
      return next
    })
  }, [])

  const handleCommit = useCallback(async () => {
    if (!commitMessage.trim() || scm.stagedFiles.length === 0) return
    setIsCommitting(true)
    const result = await scm.commit(commitMessage)
    setIsCommitting(false)
    if (result?.success) {
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

  // Helper: check if any file in a list is expanded
  const hasAnyExpanded = (files: GitFileStatus[]) => files.some(f => expandedFiles.has(f.path))

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
          {/* Expand all / Collapse all global toggle */}
          {scm.totalChanges > 0 && (
            <span
              onClick={() => {
                const allFiles = [...scm.stagedFiles, ...scm.unstagedFiles, ...scm.untrackedFiles]
                if (expandedFiles.size > 0) {
                  setExpandedFiles(new Set())
                } else {
                  setExpandedFiles(new Set(allFiles.map(f => f.path)))
                }
              }}
              style={{ cursor: 'pointer', fontSize: 11, color: colors.textMuted }}
              title={expandedFiles.size > 0 ? 'Collapse all diffs' : 'Expand all diffs'}
            >
              {expandedFiles.size > 0 ? '⊟' : '⊞'}
            </span>
          )}
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
              onExpandAll={() => expandAll(scm.stagedFiles)}
              onCollapseAll={() => collapseAll(scm.stagedFiles)}
              hasExpanded={hasAnyExpanded(scm.stagedFiles)}
            />
            {!stagedCollapsed && scm.stagedFiles.map(file => (
              <ChangeFileRow
                key={`staged-${file.path}`}
                file={file}
                category="staged"
                expanded={expandedFiles.has(file.path)}
                cwd={cwd}
                onUnstage={() => scm.unstage(file.path)}
                onToggleExpand={() => toggleExpand(file.path)}
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
                for (const f of scm.unstagedFiles) scm.stage(f.path)
              }}
              collapsed={changesCollapsed}
              onToggle={() => setChangesCollapsed(v => !v)}
              onExpandAll={() => expandAll(scm.unstagedFiles)}
              onCollapseAll={() => collapseAll(scm.unstagedFiles)}
              hasExpanded={hasAnyExpanded(scm.unstagedFiles)}
            />
            {!changesCollapsed && scm.unstagedFiles.map(file => (
              <ChangeFileRow
                key={`unstaged-${file.path}`}
                file={file}
                category="unstaged"
                expanded={expandedFiles.has(file.path)}
                cwd={cwd}
                onStage={() => scm.stage(file.path)}
                onDiscard={() => handleDiscard(file)}
                onToggleExpand={() => toggleExpand(file.path)}
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
              onExpandAll={() => expandAll(scm.untrackedFiles)}
              onCollapseAll={() => collapseAll(scm.untrackedFiles)}
              hasExpanded={hasAnyExpanded(scm.untrackedFiles)}
            />
            {!untrackedCollapsed && scm.untrackedFiles.map(file => (
              <ChangeFileRow
                key={`untracked-${file.path}`}
                file={file}
                category="untracked"
                expanded={expandedFiles.has(file.path)}
                cwd={cwd}
                onStage={() => scm.stage(file.path)}
                onDiscard={() => handleDiscard(file)}
                onToggleExpand={() => toggleExpand(file.path)}
                onContextMenu={e => handleContextMenu(e, file, 'untracked')}
              />
            ))}
          </div>
        )}
      </div>

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
