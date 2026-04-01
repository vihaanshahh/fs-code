// ── Shared diff computation utilities ──────────────────────────────

export interface DiffLine {
  type: 'add' | 'remove' | 'context'
  content: string
  oldNum?: number
  newNum?: number
}

interface DiffHunk {
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  lines: DiffLine[]
}

/** Simple LCS-based line diff */
export function computeLineDiff(oldStr: string | undefined | null, newStr: string | undefined | null): DiffLine[] {
  const oldLines = (oldStr ?? '').split('\n')
  const newLines = (newStr ?? '').split('\n')
  const m = oldLines.length
  const n = newLines.length

  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0))
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = oldLines[i - 1] === newLines[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1])
    }
  }

  let i = m, j = n
  const stack: DiffLine[] = []

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      stack.push({ type: 'context', content: oldLines[i - 1], oldNum: i, newNum: j })
      i--; j--
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      stack.push({ type: 'add', content: newLines[j - 1], newNum: j })
      j--
    } else {
      stack.push({ type: 'remove', content: oldLines[i - 1], oldNum: i })
      i--
    }
  }

  const result: DiffLine[] = []
  while (stack.length) result.push(stack.pop()!)
  return result
}

/** Split a flat diff into hunks with N lines of context */
export function splitIntoHunks(lines: DiffLine[], contextLines = 3): DiffHunk[] {
  const changedIndices: number[] = []
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].type !== 'context') changedIndices.push(i)
  }
  if (changedIndices.length === 0) return []

  const groups: [number, number][] = []
  let start = changedIndices[0]
  let end = changedIndices[0]
  for (let k = 1; k < changedIndices.length; k++) {
    if (changedIndices[k] - end <= contextLines * 2 + 1) {
      end = changedIndices[k]
    } else {
      groups.push([start, end])
      start = changedIndices[k]
      end = changedIndices[k]
    }
  }
  groups.push([start, end])

  const hunks: DiffHunk[] = []
  for (const [gs, ge] of groups) {
    const hunkStart = Math.max(0, gs - contextLines)
    const hunkEnd = Math.min(lines.length - 1, ge + contextLines)
    const hunkLines = lines.slice(hunkStart, hunkEnd + 1)

    const oldStart = hunkLines[0]?.oldNum ?? hunkLines.find(l => l.oldNum)?.oldNum ?? 1
    const newStart = hunkLines[0]?.newNum ?? hunkLines.find(l => l.newNum)?.newNum ?? 1
    const oldCount = hunkLines.filter(l => l.type !== 'add').length
    const newCount = hunkLines.filter(l => l.type !== 'remove').length

    hunks.push({ oldStart, oldCount, newStart, newCount, lines: hunkLines })
  }

  return hunks
}

export function newFileDiffLines(content: string | undefined | null): DiffLine[] {
  if (!content) return []
  return content.split('\n').map((line, i) => ({
    type: 'add' as const,
    content: line,
    newNum: i + 1,
  }))
}

export function deletedFileDiffLines(content: string | undefined | null): DiffLine[] {
  if (!content) return []
  return content.split('\n').map((line, i) => ({
    type: 'remove' as const,
    content: line,
    oldNum: i + 1,
  }))
}

export function countDiffLines(lines: DiffLine[]): { add: number; remove: number } {
  let add = 0, remove = 0
  for (const l of lines) {
    if (l.type === 'add') add++
    else if (l.type === 'remove') remove++
  }
  return { add, remove }
}
