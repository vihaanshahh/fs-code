import React, { useEffect, useState } from 'react'
import type { TrackedFile, FileOperation, FileOperationType } from '../../../shared/types'
import { useTheme } from '../../ThemeContext'
import type { ThemeColors } from '../../theme'
import { api } from '../../lib/api'
import {
  computeLineDiff, splitIntoHunks, newFileDiffLines, deletedFileDiffLines, countDiffLines,
  type DiffLine,
} from '../shared/diff-utils'
import { DiffHunkHeader, DiffLineRow, CollapsedContext, ExpandableContext } from '../shared/DiffDisplay'

// ── Helpers ─────────────────────────────────────────────────────────

const opVerb: Record<FileOperationType, string> = {
  read: 'Read',
  write: 'Edited',
  create: 'Created',
  execute: 'Executed',
}

function timeAgo(ts: number): string {
  const d = Date.now() - ts
  if (d < 60_000) return 'just now'
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`
  return new Date(ts).toLocaleTimeString()
}

function hasDiffContent(op: FileOperation): boolean {
  return !!(op.editOldString !== undefined && op.editNewString !== undefined) || !!op.writeContent
}

type GitStatus = 'untracked' | 'modified' | 'added' | 'deleted' | 'unchanged' | 'error'

function getStatusLabels(c: ThemeColors): Record<GitStatus, { text: string; color: string }> {
  return {
    modified: { text: 'Modified', color: c.amber },
    added: { text: 'New file', color: c.green },
    untracked: { text: 'Untracked', color: c.purple },
    deleted: { text: 'Deleted', color: c.red },
    unchanged: { text: 'Unchanged', color: c.textMuted },
    error: { text: 'Unknown', color: c.textMuted },
  }
}

function getOpDotColor(c: ThemeColors): Record<FileOperationType, string> {
  return {
    read: c.dotRead,
    write: c.dotWrite,
    create: c.dotCreate,
    execute: c.dotExecute,
  }
}

// ── Sub-components ──────────────────────────────────────────────────

function AgentBadge({ op }: { op: FileOperation }) {
  const { colors } = useTheme()
  const opDotColor = getOpDotColor(colors)
  const name = op.agentName || 'Agent'
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px',
      background: colors.bgSurface, borderBottom: `1px solid ${colors.border}`,
    }}>
      <span style={{
        width: 8, height: 8, borderRadius: '50%',
        background: opDotColor[op.type], flexShrink: 0,
      }} />
      <span style={{ fontSize: 12, fontWeight: 600, color: colors.text }}>{name}</span>
      <span style={{ fontSize: 11, color: colors.textSecondary }}>
        {opVerb[op.type]} via {op.toolName}
      </span>
      <span style={{ fontSize: 11, color: colors.textMuted, marginLeft: 'auto' }}>
        {timeAgo(op.timestamp)}
      </span>
    </div>
  )
}

function DiffBlock({ op }: { op: FileOperation }) {
  const { colors } = useTheme()
  const lines: DiffLine[] = (() => {
    if (op.editOldString !== undefined && op.editNewString !== undefined) {
      return computeLineDiff(op.editOldString, op.editNewString)
    }
    if (op.writeContent) return newFileDiffLines(op.writeContent)
    return []
  })()

  const { add, remove } = countDiffLines(lines)

  return (
    <div style={{
      border: `1px solid ${colors.border}`, borderRadius: 8,
      overflow: 'hidden', marginBottom: 2,
    }}>
      <AgentBadge op={op} />
      <DiffHunkHeader
        text={`@@ ${remove > 0 ? `-${remove} lines` : ''} ${add > 0 ? `+${add} lines` : ''} @@`}
      />
      <div style={{ overflow: 'auto', maxHeight: 400 }}>
        {lines.map((line, i) => <DiffLineRow key={i} line={line} />)}
      </div>
    </div>
  )
}

function TimelineEntry({ op }: { op: FileOperation }) {
  const { colors } = useTheme()
  const opDotColor = getOpDotColor(colors)
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8, padding: '6px 14px',
      borderRadius: 6, background: colors.bgSurface, marginBottom: 2,
    }}>
      <span style={{
        width: 7, height: 7, borderRadius: '50%',
        background: opDotColor[op.type], flexShrink: 0,
      }} />
      <span style={{ fontSize: 12, color: colors.textSecondary }}>{op.agentName || 'Agent'}</span>
      <span style={{ fontSize: 12, color: colors.textMuted }}>{opVerb[op.type]} via {op.toolName}</span>
      <span style={{ fontSize: 11, color: colors.textMuted, marginLeft: 'auto' }}>{timeAgo(op.timestamp)}</span>
    </div>
  )
}

// ── Total git diff view ─────────────────────────────────────────────

function TotalDiffView({ filePath, cwd }: { filePath: string; cwd?: string }) {
  const { colors, fonts } = useTheme()
  const statusLabels = getStatusLabels(colors)

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
        return api.readFile(filePath, cwd)
          .then((res: any) => {
            if (!cancelled) setGitData({ baseContent: null, currentContent: res?.content ?? '', status: 'untracked' })
          })
          .catch(() => {
            if (!cancelled) setGitData({ baseContent: null, currentContent: '', status: 'error' })
          })
      })
      .finally(() => { if (!cancelled) setLoading(false) })

    return () => { cancelled = true }
  }, [filePath, cwd])

  if (loading) {
    return <div style={{ padding: 20, color: colors.textMuted, fontSize: 13 }}>Loading diff...</div>
  }

  if (!gitData || (gitData.status === 'error' && !gitData.currentContent)) {
    return <div style={{ padding: 20, color: colors.textMuted, fontSize: 13 }}>Could not load file</div>
  }

  // Unchanged files — show the file content as context (no additions/removals)
  if (gitData.status === 'unchanged') {
    const lines = gitData.currentContent.split('\n')
    return (
      <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 0 }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px',
          background: colors.bgSurface, borderRadius: '8px 8px 0 0',
          border: `1px solid ${colors.border}`, borderBottom: 'none',
        }}>
          <span style={{
            fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 10,
            background: `${colors.green}20`, color: colors.green,
            border: `1px solid ${colors.green}40`,
          }}>
            unchanged
          </span>
          <span style={{ fontSize: 12, color: colors.textSecondary }}>matches last commit</span>
          <span style={{ fontSize: 12, color: colors.textMuted, marginLeft: 'auto', fontFamily: fonts.mono }}>{lines.length} lines</span>
        </div>
        <div style={{
          border: `1px solid ${colors.border}`, borderRadius: '0 0 8px 8px', overflow: 'hidden',
          maxHeight: 500, overflowY: 'auto',
        }}>
          {lines.map((line, i) => (
            <div key={i} style={{
              display: 'flex', fontFamily: fonts.mono, fontSize: 12,
              lineHeight: '20px', minHeight: 20,
            }}>
              <span style={{
                width: 56, textAlign: 'right', padding: '0 12px 0 0',
                color: colors.diffLineNum, userSelect: 'none', flexShrink: 0,
                borderRight: `1px solid ${colors.border}`,
              }}>
                {i + 1}
              </span>
              <span style={{ flex: 1, color: colors.text, whiteSpace: 'pre', paddingLeft: 12 }}>
                {line}
              </span>
            </div>
          ))}
        </div>
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
  const hunks = splitIntoHunks(diffLines, 8)
  const statusInfo = statusLabels[gitData.status] || statusLabels['modified']

  // Pre-compute hidden lines between hunks for expandable gaps
  const gapsBetweenHunks: { count: number; lines: DiffLine[] }[] = []
  for (let hi = 1; hi < hunks.length; hi++) {
    const prevHunk = hunks[hi - 1]
    const currHunk = hunks[hi]
    const prevEnd = prevHunk.lines[prevHunk.lines.length - 1]
    const currStart = currHunk.lines[0]

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
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 0 }}>
      {/* Status banner */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px',
        background: colors.bgSurface, borderRadius: '8px 8px 0 0',
        border: `1px solid ${colors.border}`, borderBottom: 'none',
      }}>
        <span style={{
          fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 10,
          background: `${statusInfo.color}20`, color: statusInfo.color,
          border: `1px solid ${statusInfo.color}40`,
        }}>
          {statusInfo.text}
        </span>
        <span style={{ fontSize: 12, color: colors.textSecondary }}>vs last commit</span>
        <div style={{ display: 'flex', gap: 8, marginLeft: 'auto', alignItems: 'center' }}>
          {add > 0 && (
            <span style={{ fontSize: 12, fontWeight: 600, color: colors.diffAddText, fontFamily: fonts.mono }}>+{add}</span>
          )}
          {remove > 0 && (
            <span style={{ fontSize: 12, fontWeight: 600, color: colors.diffRemoveText, fontFamily: fonts.mono }}>-{remove}</span>
          )}
          <div style={{ display: 'flex', gap: 1, height: 8 }}>
            {Array.from({ length: Math.min(add, 25) }).map((_, i) => (
              <span key={`a${i}`} style={{ width: 3, height: 8, borderRadius: 1, background: colors.diffAddText }} />
            ))}
            {Array.from({ length: Math.min(remove, 25) }).map((_, i) => (
              <span key={`r${i}`} style={{ width: 3, height: 8, borderRadius: 1, background: colors.diffRemoveText }} />
            ))}
          </div>
        </div>
      </div>

      {/* Hunked diff */}
      <div style={{
        border: `1px solid ${colors.border}`, borderRadius: '0 0 8px 8px', overflow: 'hidden',
      }}>
        {hunks.length === 0 && diffLines.length > 0 ? (
          diffLines.map((line, i) => <DiffLineRow key={i} line={line} />)
        ) : hunks.length === 0 ? (
          <div style={{ padding: 20, color: colors.textMuted, fontSize: 13, textAlign: 'center' }}>Empty file</div>
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
    </div>
  )
}

// ── Stat summary (session) ──────────────────────────────────────────

function SessionDiffStats({ operations }: { operations: FileOperation[] }) {
  const { colors, fonts } = useTheme()
  const diffs = operations.filter(hasDiffContent)
  let totalAdd = 0, totalRemove = 0

  for (const op of diffs) {
    if (op.editOldString !== undefined && op.editNewString !== undefined) {
      const diff = computeLineDiff(op.editOldString, op.editNewString)
      const c = countDiffLines(diff)
      totalAdd += c.add
      totalRemove += c.remove
    } else if (op.writeContent) {
      totalAdd += op.writeContent.split('\n').length
    }
  }

  if (totalAdd === 0 && totalRemove === 0) return null

  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
      {totalAdd > 0 && (
        <span style={{ fontSize: 12, fontWeight: 600, color: colors.diffAddText, fontFamily: fonts.mono }}>+{totalAdd}</span>
      )}
      {totalRemove > 0 && (
        <span style={{ fontSize: 12, fontWeight: 600, color: colors.diffRemoveText, fontFamily: fonts.mono }}>-{totalRemove}</span>
      )}
      <div style={{ display: 'flex', gap: 1, height: 8 }}>
        {Array.from({ length: Math.min(totalAdd, 20) }).map((_, i) => (
          <span key={`a${i}`} style={{ width: 4, height: 8, borderRadius: 1, background: colors.diffAddText }} />
        ))}
        {Array.from({ length: Math.min(totalRemove, 20) }).map((_, i) => (
          <span key={`r${i}`} style={{ width: 4, height: 8, borderRadius: 1, background: colors.diffRemoveText }} />
        ))}
      </div>
    </div>
  )
}

// ── Main component ──────────────────────────────────────────────────

type TabId = 'total' | 'session' | 'source'

export default function FileDetailModal({
  file,
  cwd,
  onClose,
}: {
  file: TrackedFile
  cwd?: string
  onClose: () => void
}) {
  const { colors, fonts } = useTheme()
  const [tab, setTab] = useState<TabId>('total')
  const [content, setContent] = useState<string | null>(null)
  const [language, setLanguage] = useState('plaintext')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    api.readFile(file.path, cwd)
      .then((res: any) => {
        setContent(res?.content ?? '// Could not read file')
        setLanguage(res?.language ?? 'plaintext')
      })
      .catch(() => setContent('// Could not read file'))
      .finally(() => setLoading(false))
  }, [file.path, cwd])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const diffOps = file.operations.filter(hasDiffContent)
  const nonDiffOps = file.operations.filter(op => !hasDiffContent(op))
  const hasSessionDiffs = diffOps.length > 0

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: colors.fileModalOverlay,
        backdropFilter: 'blur(8px)', display: 'flex',
        animation: 'modalIn 0.2s ease',
      }}
      onClick={onClose}
    >
      <div
        style={{
          flex: 1, margin: 20, background: colors.bg, borderRadius: 12,
          border: `1px solid ${colors.border}`, display: 'flex',
          flexDirection: 'column', overflow: 'hidden',
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* ── Header ── */}
        <div style={{
          padding: '10px 16px', borderBottom: `1px solid ${colors.border}`,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flex: 1 }}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
              <path d="M3 1.5h6.5L13 5v9.5H3V1.5z" stroke={colors.textMuted} strokeWidth="1.2" fill="none" />
              <path d="M9.5 1.5V5H13" stroke={colors.textMuted} strokeWidth="1.2" fill="none" />
            </svg>
            <span style={{
              fontSize: 13, fontWeight: 600, color: colors.text, fontFamily: fonts.mono,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {file.path}
            </span>
            <span style={{
              fontSize: 10, padding: '2px 6px',
              background: `${colors.blue}15`, color: colors.blue,
              borderRadius: 4, flexShrink: 0,
            }}>
              {language}
            </span>
            <SessionDiffStats operations={file.operations} />
          </div>

          <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexShrink: 0 }}>
            <TabButton label="Total" active={tab === 'total'} onClick={() => setTab('total')} />
            {hasSessionDiffs && (
              <TabButton label="Session" active={tab === 'session'} onClick={() => setTab('session')} />
            )}
            <TabButton label="Source" active={tab === 'source'} onClick={() => setTab('source')} />
            <button
              onClick={onClose}
              style={{
                background: 'none', border: `1px solid ${colors.borderMuted}`,
                color: colors.textSecondary, borderRadius: 6, padding: '4px 10px',
                fontSize: 12, cursor: 'pointer', marginLeft: 8,
              }}
            >
              Esc
            </button>
          </div>
        </div>

        {/* ── Body ── */}
        <div style={{ flex: 1, overflow: 'auto' }}>
          {tab === 'total' && <TotalDiffView filePath={file.path} cwd={cwd} />}

          {tab === 'session' && (
            <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>
              {diffOps.map((op, i) => <DiffBlock key={op.toolUseId || i} op={op} />)}
              {nonDiffOps.length > 0 && (
                <div>
                  <div style={{
                    fontSize: 11, fontWeight: 600, color: colors.textMuted,
                    textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8, padding: '0 2px',
                  }}>
                    Other Activity
                  </div>
                  {nonDiffOps.map((op, i) => <TimelineEntry key={op.toolUseId || i} op={op} />)}
                </div>
              )}
            </div>
          )}

          {tab === 'source' && (
            loading ? (
              <div style={{ padding: 20, color: colors.textMuted, fontSize: 13 }}>Loading...</div>
            ) : (
              <div style={{ overflow: 'auto' }}>
                {content?.split('\n').map((line, i) => (
                  <div key={i} style={{
                    display: 'flex', fontFamily: fonts.mono, fontSize: 12,
                    lineHeight: '20px', minHeight: 20,
                  }}>
                    <span style={{
                      width: 56, textAlign: 'right', padding: '0 12px 0 0',
                      color: colors.diffLineNum, userSelect: 'none', flexShrink: 0,
                      borderRight: `1px solid ${colors.border}`,
                    }}>
                      {i + 1}
                    </span>
                    <span style={{
                      flex: 1, color: colors.text, whiteSpace: 'pre',
                      paddingLeft: 12, paddingRight: 12,
                    }}>
                      {line}
                    </span>
                  </div>
                ))}
              </div>
            )
          )}
        </div>
      </div>
    </div>
  )
}

function TabButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  const { colors } = useTheme()
  return (
    <button
      onClick={onClick}
      style={{
        background: active ? colors.bgSurface : 'transparent',
        border: `1px solid ${active ? colors.borderMuted : 'transparent'}`,
        color: active ? colors.text : colors.textMuted,
        borderRadius: 6, padding: '4px 10px', fontSize: 12,
        fontWeight: active ? 600 : 400, cursor: 'pointer',
        transition: 'all 0.15s ease',
      }}
    >
      {label}
    </button>
  )
}
