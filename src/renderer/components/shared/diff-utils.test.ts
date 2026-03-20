import { describe, it, expect } from 'vitest'
import {
  computeLineDiff,
  splitIntoHunks,
  newFileDiffLines,
  deletedFileDiffLines,
  countDiffLines,
  DiffLine,
} from './diff-utils'

// ── computeLineDiff ─────────────────────────────────────────────────

describe('computeLineDiff', () => {
  it('identical content → all context lines', () => {
    const lines = computeLineDiff('a\nb\nc', 'a\nb\nc')
    expect(lines).toHaveLength(3)
    expect(lines.every(l => l.type === 'context')).toBe(true)
  })

  it('single line added', () => {
    const lines = computeLineDiff('a\nc', 'a\nb\nc')
    const added = lines.filter(l => l.type === 'add')
    expect(added).toHaveLength(1)
    expect(added[0].content).toBe('b')
  })

  it('single line removed', () => {
    const lines = computeLineDiff('a\nb\nc', 'a\nc')
    const removed = lines.filter(l => l.type === 'remove')
    expect(removed).toHaveLength(1)
    expect(removed[0].content).toBe('b')
  })

  it('single line modified', () => {
    const lines = computeLineDiff('a\nold\nc', 'a\nnew\nc')
    const removed = lines.filter(l => l.type === 'remove')
    const added = lines.filter(l => l.type === 'add')
    expect(removed).toHaveLength(1)
    expect(removed[0].content).toBe('old')
    expect(added).toHaveLength(1)
    expect(added[0].content).toBe('new')
  })

  it('multi-line additions', () => {
    const lines = computeLineDiff('a', 'a\nb\nc\nd')
    const added = lines.filter(l => l.type === 'add')
    expect(added).toHaveLength(3)
    expect(added.map(l => l.content)).toEqual(['b', 'c', 'd'])
  })

  it('multi-line deletions', () => {
    const lines = computeLineDiff('a\nb\nc\nd', 'a')
    const removed = lines.filter(l => l.type === 'remove')
    expect(removed).toHaveLength(3)
    expect(removed.map(l => l.content)).toEqual(['b', 'c', 'd'])
  })

  it('complete rewrite (no common lines)', () => {
    const lines = computeLineDiff('a\nb', 'x\ny')
    const removed = lines.filter(l => l.type === 'remove')
    const added = lines.filter(l => l.type === 'add')
    expect(removed).toHaveLength(2)
    expect(added).toHaveLength(2)
    expect(lines.filter(l => l.type === 'context')).toHaveLength(0)
  })

  it('empty old string (new file)', () => {
    const lines = computeLineDiff('', 'hello\nworld')
    const added = lines.filter(l => l.type === 'add')
    // empty string splits to [''] so we have 1 remove for the empty line + 2 adds
    expect(added.length).toBeGreaterThanOrEqual(2)
  })

  it('empty new string (deleted file)', () => {
    const lines = computeLineDiff('hello\nworld', '')
    const removed = lines.filter(l => l.type === 'remove')
    expect(removed.length).toBeGreaterThanOrEqual(2)
  })

  it('both empty', () => {
    const lines = computeLineDiff('', '')
    expect(lines).toHaveLength(1) // single empty line context
    expect(lines[0].type).toBe('context')
  })

  it('line numbering — context lines have both oldNum and newNum', () => {
    const lines = computeLineDiff('a\nb\nc', 'a\nb\nc')
    for (const line of lines) {
      expect(line.oldNum).toBeDefined()
      expect(line.newNum).toBeDefined()
    }
  })

  it('line numbering — added lines have newNum only', () => {
    const lines = computeLineDiff('a', 'a\nb')
    const added = lines.filter(l => l.type === 'add')
    for (const line of added) {
      expect(line.newNum).toBeDefined()
      expect(line.oldNum).toBeUndefined()
    }
  })

  it('line numbering — removed lines have oldNum only', () => {
    const lines = computeLineDiff('a\nb', 'a')
    const removed = lines.filter(l => l.type === 'remove')
    for (const line of removed) {
      expect(line.oldNum).toBeDefined()
      expect(line.newNum).toBeUndefined()
    }
  })

  it('whitespace-only changes', () => {
    const lines = computeLineDiff('a\n  b\nc', 'a\nb\nc')
    // '  b' !== 'b' so there should be a change
    const removed = lines.filter(l => l.type === 'remove')
    const added = lines.filter(l => l.type === 'add')
    expect(removed).toHaveLength(1)
    expect(removed[0].content).toBe('  b')
    expect(added).toHaveLength(1)
    expect(added[0].content).toBe('b')
  })

  it('large diff (100+ lines) completes without error', () => {
    const oldLines = Array.from({ length: 100 }, (_, i) => `line ${i}`)
    const newLines = Array.from({ length: 100 }, (_, i) => `new line ${i}`)
    const lines = computeLineDiff(oldLines.join('\n'), newLines.join('\n'))
    expect(lines.length).toBeGreaterThan(0)
  })

  it('preserves line order', () => {
    const lines = computeLineDiff('a\nb\nc', 'a\nB\nc')
    const contents = lines.map(l => l.content)
    // 'a' should be first, 'c' should be last
    expect(contents[0]).toBe('a')
    expect(contents[contents.length - 1]).toBe('c')
  })

  it('sequential line numbers increment correctly', () => {
    const lines = computeLineDiff('a\nb\nc\nd', 'a\nb\nc\nd')
    expect(lines.map(l => l.oldNum)).toEqual([1, 2, 3, 4])
    expect(lines.map(l => l.newNum)).toEqual([1, 2, 3, 4])
  })
})

// ── splitIntoHunks ──────────────────────────────────────────────────

describe('splitIntoHunks', () => {
  function makeContext(n: number, startOld = 1, startNew = 1): DiffLine[] {
    return Array.from({ length: n }, (_, i) => ({
      type: 'context' as const,
      content: `line ${i}`,
      oldNum: startOld + i,
      newNum: startNew + i,
    }))
  }

  it('no changes → empty array', () => {
    const ctx = makeContext(10)
    expect(splitIntoHunks(ctx)).toEqual([])
  })

  it('single change → one hunk', () => {
    const lines: DiffLine[] = [
      ...makeContext(5),
      { type: 'add', content: 'new', newNum: 6 },
      ...makeContext(5, 6, 7),
    ]
    const hunks = splitIntoHunks(lines)
    expect(hunks).toHaveLength(1)
  })

  it('two distant changes → two hunks', () => {
    const lines: DiffLine[] = [
      ...makeContext(5),
      { type: 'add', content: 'first', newNum: 6 },
      ...makeContext(20, 6, 7),
      { type: 'add', content: 'second', newNum: 27 },
      ...makeContext(5, 26, 28),
    ]
    const hunks = splitIntoHunks(lines)
    expect(hunks).toHaveLength(2)
  })

  it('two close changes → merged into one hunk', () => {
    const lines: DiffLine[] = [
      ...makeContext(3),
      { type: 'add', content: 'first', newNum: 4 },
      ...makeContext(3, 4, 5),
      { type: 'add', content: 'second', newNum: 8 },
      ...makeContext(3, 7, 9),
    ]
    const hunks = splitIntoHunks(lines)
    expect(hunks).toHaveLength(1)
  })

  it('change at start of file (no leading context)', () => {
    const lines: DiffLine[] = [
      { type: 'add', content: 'first', newNum: 1 },
      ...makeContext(5, 1, 2),
    ]
    const hunks = splitIntoHunks(lines)
    expect(hunks).toHaveLength(1)
    // Hunk should start from the very first line
    expect(hunks[0].lines[0].content).toBe('first')
  })

  it('change at end of file (no trailing context)', () => {
    const lines: DiffLine[] = [
      ...makeContext(5),
      { type: 'add', content: 'last', newNum: 6 },
    ]
    const hunks = splitIntoHunks(lines)
    expect(hunks).toHaveLength(1)
    expect(hunks[0].lines[hunks[0].lines.length - 1].content).toBe('last')
  })

  it('custom context lines parameter', () => {
    const lines: DiffLine[] = [
      ...makeContext(10),
      { type: 'add', content: 'new', newNum: 11 },
      ...makeContext(10, 11, 12),
    ]
    const hunks1 = splitIntoHunks(lines, 1)
    expect(hunks1).toHaveLength(1)
    // With 1 line of context, the hunk should be smaller
    expect(hunks1[0].lines.length).toBeLessThanOrEqual(3) // 1 ctx before + add + 1 ctx after
  })

  it('hunk header values (oldCount, newCount)', () => {
    const lines: DiffLine[] = [
      ...makeContext(5),
      { type: 'remove', content: 'old', oldNum: 6 },
      { type: 'add', content: 'new', newNum: 6 },
      ...makeContext(5, 7, 7),
    ]
    const hunks = splitIntoHunks(lines)
    expect(hunks).toHaveLength(1)
    // oldCount = context lines + remove lines (no adds)
    // newCount = context lines + add lines (no removes)
    expect(hunks[0].oldCount).toBe(hunks[0].lines.filter(l => l.type !== 'add').length)
    expect(hunks[0].newCount).toBe(hunks[0].lines.filter(l => l.type !== 'remove').length)
  })

  it('empty lines array → empty array', () => {
    expect(splitIntoHunks([])).toEqual([])
  })
})

// ── newFileDiffLines ────────────────────────────────────────────────

describe('newFileDiffLines', () => {
  it('all lines marked as add', () => {
    const lines = newFileDiffLines('a\nb\nc')
    expect(lines).toHaveLength(3)
    expect(lines.every(l => l.type === 'add')).toBe(true)
  })

  it('line numbering starts at 1 (newNum)', () => {
    const lines = newFileDiffLines('a\nb')
    expect(lines[0].newNum).toBe(1)
    expect(lines[1].newNum).toBe(2)
  })

  it('no oldNum on any line', () => {
    const lines = newFileDiffLines('a\nb')
    expect(lines.every(l => l.oldNum === undefined)).toBe(true)
  })

  it('single line', () => {
    const lines = newFileDiffLines('hello')
    expect(lines).toHaveLength(1)
    expect(lines[0].content).toBe('hello')
  })

  it('empty string → single empty-content add line', () => {
    const lines = newFileDiffLines('')
    expect(lines).toHaveLength(1)
    expect(lines[0].content).toBe('')
    expect(lines[0].type).toBe('add')
  })
})

// ── deletedFileDiffLines ────────────────────────────────────────────

describe('deletedFileDiffLines', () => {
  it('all lines marked as remove', () => {
    const lines = deletedFileDiffLines('a\nb\nc')
    expect(lines).toHaveLength(3)
    expect(lines.every(l => l.type === 'remove')).toBe(true)
  })

  it('line numbering starts at 1 (oldNum)', () => {
    const lines = deletedFileDiffLines('a\nb')
    expect(lines[0].oldNum).toBe(1)
    expect(lines[1].oldNum).toBe(2)
  })

  it('no newNum on any line', () => {
    const lines = deletedFileDiffLines('a\nb')
    expect(lines.every(l => l.newNum === undefined)).toBe(true)
  })

  it('single line', () => {
    const lines = deletedFileDiffLines('hello')
    expect(lines).toHaveLength(1)
    expect(lines[0].content).toBe('hello')
  })

  it('empty string → single empty-content remove line', () => {
    const lines = deletedFileDiffLines('')
    expect(lines).toHaveLength(1)
    expect(lines[0].content).toBe('')
    expect(lines[0].type).toBe('remove')
  })
})

// ── countDiffLines ──────────────────────────────────────────────────

describe('countDiffLines', () => {
  it('mixed add/remove/context', () => {
    const lines: DiffLine[] = [
      { type: 'add', content: 'a' },
      { type: 'remove', content: 'b' },
      { type: 'context', content: 'c' },
      { type: 'add', content: 'd' },
    ]
    expect(countDiffLines(lines)).toEqual({ add: 2, remove: 1 })
  })

  it('all adds', () => {
    const lines: DiffLine[] = [
      { type: 'add', content: 'a' },
      { type: 'add', content: 'b' },
    ]
    expect(countDiffLines(lines)).toEqual({ add: 2, remove: 0 })
  })

  it('all removes', () => {
    const lines: DiffLine[] = [
      { type: 'remove', content: 'a' },
      { type: 'remove', content: 'b' },
    ]
    expect(countDiffLines(lines)).toEqual({ add: 0, remove: 2 })
  })

  it('no changes (all context)', () => {
    const lines: DiffLine[] = [
      { type: 'context', content: 'a' },
      { type: 'context', content: 'b' },
    ]
    expect(countDiffLines(lines)).toEqual({ add: 0, remove: 0 })
  })

  it('empty array', () => {
    expect(countDiffLines([])).toEqual({ add: 0, remove: 0 })
  })
})
