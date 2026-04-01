import React, { useEffect, useState } from 'react'
import { useTheme } from '../../ThemeContext'
import { api } from '../../lib/api'
import {
  computeLineDiff, splitIntoHunks, newFileDiffLines, deletedFileDiffLines, countDiffLines,
  type DiffLine,
} from '../shared/diff-utils'
import { DiffHunkHeader, DiffLineRow, CollapsedContext } from '../shared/DiffDisplay'

type GitStatus = 'untracked' | 'modified' | 'added' | 'deleted' | 'unchanged' | 'error'

export default function DiffView({
  filePath,
  cwd,
  onClose,
}: {
  filePath: string
  cwd: string
  onClose: () => void
}) {
  const { colors, fonts } = useTheme()

  const [gitData, setGitData] = useState<{
    baseContent: string | null
    currentContent: string
    status: GitStatus
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

  // Extract filename
  const basename = filePath.split('/').pop() || filePath

  if (loading) {
    return (
      <div style={{
        borderTop: `1px solid ${colors.border}`,
        maxHeight: '50%',
        overflow: 'auto',
        padding: 12,
        fontSize: 12,
        color: colors.textMuted,
      }}>
        Loading diff...
      </div>
    )
  }

  if (!gitData || gitData.status === 'error' || gitData.status === 'unchanged') {
    return (
      <div style={{
        borderTop: `1px solid ${colors.border}`,
        maxHeight: '50%',
        padding: 12,
        fontSize: 12,
        color: colors.textMuted,
      }}>
        {gitData?.status === 'unchanged' ? 'No changes' : 'Could not load diff'}
        <span onClick={onClose} style={{ cursor: 'pointer', float: 'right', color: colors.textMuted }}>✕</span>
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

  const { add, remove } = countDiffLines(diffLines)
  const hunks = splitIntoHunks(diffLines)

  const statusLabels: Record<string, { text: string; color: string }> = {
    modified: { text: 'M', color: colors.amber },
    added: { text: 'A', color: colors.green },
    untracked: { text: 'U', color: colors.purple },
    deleted: { text: 'D', color: colors.red },
  }
  const statusInfo = statusLabels[gitData.status] || { text: '?', color: colors.textMuted }

  return (
    <div style={{
      borderTop: `1px solid ${colors.border}`,
      maxHeight: '50%',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
    }}>
      {/* Diff header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 10px',
        background: colors.bgSurface,
        borderBottom: `1px solid ${colors.border}`,
        userSelect: 'none',
        flexShrink: 0,
      }}>
        <span style={{
          fontSize: 11,
          fontWeight: 700,
          color: statusInfo.color,
          fontFamily: fonts.mono,
        }}>
          {statusInfo.text}
        </span>
        <span style={{
          fontSize: 12,
          color: colors.text,
          fontFamily: fonts.mono,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          flex: 1,
        }}>
          {basename}
        </span>
        {add > 0 && (
          <span style={{ fontSize: 11, fontWeight: 600, color: colors.diffAddText, fontFamily: fonts.mono }}>+{add}</span>
        )}
        {remove > 0 && (
          <span style={{ fontSize: 11, fontWeight: 600, color: colors.diffRemoveText, fontFamily: fonts.mono }}>-{remove}</span>
        )}
        <span
          onClick={onClose}
          style={{ cursor: 'pointer', fontSize: 12, color: colors.textMuted, padding: '0 2px' }}
          title="Close diff"
        >
          ✕
        </span>
      </div>

      {/* Diff hunks */}
      <div style={{ flex: 1, overflow: 'auto' }}>
        {hunks.length === 0 && diffLines.length > 0 ? (
          diffLines.map((line, i) => <DiffLineRow key={i} line={line} />)
        ) : hunks.length === 0 ? (
          <div style={{ padding: 12, color: colors.textMuted, fontSize: 12, textAlign: 'center' }}>Empty file</div>
        ) : (
          hunks.map((hunk, hi) => (
            <div key={hi}>
              {hi > 0 && (
                <CollapsedContext count={
                  (hunk.lines[0]?.oldNum ?? hunk.oldStart) -
                  (hunks[hi - 1].lines[hunks[hi - 1].lines.length - 1]?.oldNum ?? 0) - 1
                } />
              )}
              <DiffHunkHeader
                text={`@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`}
              />
              {hunk.lines.map((line, li) => <DiffLineRow key={li} line={line} />)}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
