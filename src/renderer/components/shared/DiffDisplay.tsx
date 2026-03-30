import React, { useState } from 'react'
import { useTheme } from '../../ThemeContext'
import type { DiffLine } from './diff-utils'

export function DiffHunkHeader({ text }: { text: string }) {
  const { colors, fonts } = useTheme()
  return (
    <div style={{
      background: colors.diffHunkBg,
      color: colors.diffHunkText,
      padding: '4px 12px',
      fontSize: 12,
      fontFamily: fonts.mono,
      borderTop: `1px solid ${colors.border}`,
      borderBottom: `1px solid ${colors.border}`,
      userSelect: 'none',
    }}>
      {text}
    </div>
  )
}

export function DiffLineRow({ line }: { line: DiffLine }) {
  const { colors, fonts } = useTheme()
  const isAdd = line.type === 'add'
  const isRemove = line.type === 'remove'
  const bg = isAdd ? colors.diffAddBg : isRemove ? colors.diffRemoveBg : 'transparent'
  const prefix = isAdd ? '+' : isRemove ? '-' : ' '
  const textColor = isAdd ? colors.diffAddText : isRemove ? colors.diffRemoveText : colors.text

  return (
    <div style={{
      display: 'flex',
      background: bg,
      fontFamily: fonts.mono,
      fontSize: 12,
      lineHeight: '20px',
      minHeight: 20,
    }}>
      <span style={{
        width: 48, textAlign: 'right', padding: '0 8px 0 0',
        color: isRemove ? colors.diffLineNumActive : colors.diffLineNum,
        userSelect: 'none', flexShrink: 0, borderRight: `1px solid ${colors.border}`,
      }}>
        {line.oldNum ?? ''}
      </span>
      <span style={{
        width: 48, textAlign: 'right', padding: '0 8px 0 0',
        color: isAdd ? colors.diffLineNumActive : colors.diffLineNum,
        userSelect: 'none', flexShrink: 0, borderRight: `1px solid ${colors.border}`,
      }}>
        {line.newNum ?? ''}
      </span>
      <span style={{
        width: 20, textAlign: 'center', color: textColor,
        userSelect: 'none', flexShrink: 0, fontWeight: 700,
      }}>
        {prefix}
      </span>
      <span style={{
        flex: 1, color: textColor, whiteSpace: 'pre', overflow: 'hidden', paddingRight: 12,
      }}>
        {line.content}
      </span>
    </div>
  )
}

export function CollapsedContext({ count }: { count: number }) {
  const { colors, fonts } = useTheme()
  if (count <= 0) return null
  return (
    <div style={{
      background: colors.bgSurface,
      borderTop: `1px solid ${colors.border}`,
      borderBottom: `1px solid ${colors.border}`,
      padding: '2px 12px',
      fontSize: 11,
      color: colors.textMuted,
      fontFamily: fonts.mono,
      textAlign: 'center',
      userSelect: 'none',
    }}>
      ··· {count} unchanged lines hidden ···
    </div>
  )
}

/**
 * Expandable collapsed context — click to reveal the hidden lines between hunks.
 * `hiddenLines` are the actual DiffLine[] that were omitted between two hunks.
 */
export function ExpandableContext({ count, hiddenLines }: { count: number; hiddenLines: DiffLine[] }) {
  const { colors, fonts } = useTheme()
  const [expanded, setExpanded] = useState(false)

  if (count <= 0) return null

  if (expanded) {
    return (
      <>
        {hiddenLines.map((line, i) => <DiffLineRow key={i} line={line} />)}
      </>
    )
  }

  return (
    <div
      onClick={() => setExpanded(true)}
      style={{
        background: colors.bgSurface,
        borderTop: `1px solid ${colors.border}`,
        borderBottom: `1px solid ${colors.border}`,
        padding: '3px 12px',
        fontSize: 11,
        color: colors.textMuted,
        fontFamily: fonts.mono,
        textAlign: 'center',
        userSelect: 'none',
        cursor: 'pointer',
        transition: 'background 0.1s ease',
      }}
      onMouseEnter={e => { e.currentTarget.style.background = `${colors.blue}12`; e.currentTarget.style.color = colors.blue }}
      onMouseLeave={e => { e.currentTarget.style.background = colors.bgSurface; e.currentTarget.style.color = colors.textMuted }}
    >
      ↕ {count} unchanged lines — click to expand
    </div>
  )
}
