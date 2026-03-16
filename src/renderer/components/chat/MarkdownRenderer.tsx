import React from 'react'
import { useTheme } from '../../ThemeContext'
import type { ThemeColors } from '../../theme'

// ── Inline parsing ─────────────────────────────────────────────────

type InlineNode =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'bold'; children: InlineNode[] }
  | { type: 'italic'; children: InlineNode[] }
  | { type: 'link'; href: string; children: InlineNode[] }

function parseInline(src: string): InlineNode[] {
  const nodes: InlineNode[] = []
  let i = 0

  while (i < src.length) {
    // Inline code: `...`
    if (src[i] === '`') {
      const end = src.indexOf('`', i + 1)
      if (end !== -1) {
        nodes.push({ type: 'code', text: src.slice(i + 1, end) })
        i = end + 1
        continue
      }
    }

    // Bold: **...**
    if (src[i] === '*' && src[i + 1] === '*') {
      const end = src.indexOf('**', i + 2)
      if (end !== -1) {
        nodes.push({ type: 'bold', children: parseInline(src.slice(i + 2, end)) })
        i = end + 2
        continue
      }
    }

    // Italic: *...*  (single, not followed by another *)
    if (src[i] === '*' && src[i + 1] !== '*') {
      const end = src.indexOf('*', i + 1)
      if (end !== -1 && src[end + 1] !== '*') {
        nodes.push({ type: 'italic', children: parseInline(src.slice(i + 1, end)) })
        i = end + 1
        continue
      }
    }

    // Link: [text](url)
    if (src[i] === '[') {
      const closeBracket = src.indexOf(']', i + 1)
      if (closeBracket !== -1 && src[closeBracket + 1] === '(') {
        const closeParen = src.indexOf(')', closeBracket + 2)
        if (closeParen !== -1) {
          const text = src.slice(i + 1, closeBracket)
          const href = src.slice(closeBracket + 2, closeParen)
          nodes.push({ type: 'link', href, children: parseInline(text) })
          i = closeParen + 1
          continue
        }
      }
    }

    // Plain text — accumulate until next special char
    let textEnd = i + 1
    while (textEnd < src.length && !'`*['.includes(src[textEnd])) textEnd++
    nodes.push({ type: 'text', text: src.slice(i, textEnd) })
    i = textEnd
  }

  return nodes
}

function renderInline(nodes: InlineNode[], c: ThemeColors, monoFont: string, keyPrefix = ''): React.ReactNode[] {
  return nodes.map((node, i) => {
    const key = `${keyPrefix}${i}`
    switch (node.type) {
      case 'text':
        return <span key={key}>{node.text}</span>
      case 'code':
        return (
          <code key={key} style={{
            fontFamily: monoFont,
            fontSize: '0.9em',
            background: `${c.bgSurface}`,
            border: `1px solid ${c.border}`,
            borderRadius: 4,
            padding: '1px 5px',
            color: c.textLink,
          }}>
            {node.text}
          </code>
        )
      case 'bold':
        return <strong key={key} style={{ fontWeight: 600, color: c.text }}>{renderInline(node.children, c, monoFont, key)}</strong>
      case 'italic':
        return <em key={key} style={{ fontStyle: 'italic', color: c.textSecondary }}>{renderInline(node.children, c, monoFont, key)}</em>
      case 'link':
        return (
          <a key={key} href={node.href} target="_blank" rel="noopener noreferrer" style={{
            color: c.textLink,
            textDecoration: 'none',
            borderBottom: `1px solid ${c.textLink}40`,
          }}>
            {renderInline(node.children, c, monoFont, key)}
          </a>
        )
    }
  })
}

// ── Block parsing ──────────────────────────────────────────────────

type TableAlign = 'left' | 'center' | 'right'

type Block =
  | { type: 'paragraph'; text: string }
  | { type: 'heading'; level: number; text: string }
  | { type: 'code-block'; lang: string; code: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'table'; headers: string[]; aligns: TableAlign[]; rows: string[][] }
  | { type: 'hr' }
  | { type: 'blockquote'; text: string }

function parseBlocks(src: string): Block[] {
  const lines = src.split('\n')
  const blocks: Block[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    // Fenced code block
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim()
      const codeLines: string[] = []
      i++
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i])
        i++
      }
      blocks.push({ type: 'code-block', lang, code: codeLines.join('\n') })
      i++ // skip closing ```
      continue
    }

    // Heading
    const headingMatch = line.match(/^(#{1,4})\s+(.+)/)
    if (headingMatch) {
      blocks.push({ type: 'heading', level: headingMatch[1].length, text: headingMatch[2] })
      i++
      continue
    }

    // Table: header row | sep row | data rows
    if (
      line.includes('|') &&
      i + 1 < lines.length &&
      /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(lines[i + 1])
    ) {
      const parseCells = (row: string): string[] =>
        row.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim())

      const headers = parseCells(line)
      const sepCells = parseCells(lines[i + 1])
      const aligns: TableAlign[] = sepCells.map(cell => {
        const left = cell.startsWith(':')
        const right = cell.endsWith(':')
        if (left && right) return 'center'
        if (right) return 'right'
        return 'left'
      })

      i += 2 // skip header + separator
      const rows: string[][] = []
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        rows.push(parseCells(lines[i]))
        i++
      }
      blocks.push({ type: 'table', headers, aligns, rows })
      continue
    }

    // Horizontal rule
    if (/^(-{3,}|_{3,}|\*{3,})\s*$/.test(line)) {
      blocks.push({ type: 'hr' })
      i++
      continue
    }

    // Blockquote
    if (line.startsWith('> ')) {
      const quoteLines: string[] = []
      while (i < lines.length && lines[i].startsWith('> ')) {
        quoteLines.push(lines[i].slice(2))
        i++
      }
      blocks.push({ type: 'blockquote', text: quoteLines.join('\n') })
      continue
    }

    // Unordered list
    if (/^\s*[-*+]\s/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*[-*+]\s/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s/, ''))
        i++
      }
      blocks.push({ type: 'list', ordered: false, items })
      continue
    }

    // Ordered list
    if (/^\s*\d+[.)]\s/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*\d+[.)]\s/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+[.)]\s/, ''))
        i++
      }
      blocks.push({ type: 'list', ordered: true, items })
      continue
    }

    // Empty line — skip
    if (line.trim() === '') {
      i++
      continue
    }

    // Paragraph — accumulate non-empty lines that aren't special
    const isTableStart = (idx: number) =>
      lines[idx]?.includes('|') &&
      idx + 1 < lines.length &&
      /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(lines[idx + 1])

    const paraLines: string[] = []
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !lines[i].startsWith('```') &&
      !lines[i].match(/^#{1,4}\s/) &&
      !lines[i].startsWith('> ') &&
      !/^\s*[-*+]\s/.test(lines[i]) &&
      !/^\s*\d+[.)]\s/.test(lines[i]) &&
      !/^(-{3,}|_{3,}|\*{3,})\s*$/.test(lines[i]) &&
      !isTableStart(i)
    ) {
      paraLines.push(lines[i])
      i++
    }
    if (paraLines.length > 0) {
      blocks.push({ type: 'paragraph', text: paraLines.join('\n') })
    }
  }

  return blocks
}

// ── Code block with copy button ────────────────────────────────────

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const { colors, fonts } = useTheme()
  const [copied, setCopied] = React.useState(false)

  const handleCopy = () => {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <div style={{
      margin: '8px 0',
      borderRadius: 8,
      overflow: 'hidden',
      border: `1px solid ${colors.border}`,
      background: colors.bgOverlay,
    }}>
      {/* Header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '4px 12px',
        borderBottom: `1px solid ${colors.border}`,
        background: colors.bgSurface,
      }}>
        <span style={{
          fontSize: 10,
          fontFamily: fonts.mono,
          color: colors.textMuted,
          textTransform: 'uppercase',
          letterSpacing: 0.5,
        }}>
          {lang || 'code'}
        </span>
        <span
          onClick={handleCopy}
          style={{
            fontSize: 10,
            color: copied ? colors.green : colors.textMuted,
            cursor: 'pointer',
            fontFamily: fonts.mono,
            userSelect: 'none',
            transition: 'color 0.15s ease',
          }}
        >
          {copied ? 'Copied!' : 'Copy'}
        </span>
      </div>
      {/* Code */}
      <pre style={{
        margin: 0,
        padding: '10px 14px',
        fontSize: 12,
        fontFamily: fonts.mono,
        color: colors.text,
        lineHeight: 1.55,
        overflowX: 'auto',
        tabSize: 2,
      }}>
        {code}
      </pre>
    </div>
  )
}

// ── Main renderer ──────────────────────────────────────────────────

export default function MarkdownRenderer({ text }: { text: string }) {
  const { colors, fonts } = useTheme()
  const blocks = parseBlocks(text || '')
  const ri = (nodes: InlineNode[], keyPrefix = '') => renderInline(nodes, colors, fonts.mono, keyPrefix)

  return (
    <div style={{ fontSize: 13, color: colors.text, lineHeight: 1.6 }}>
      {blocks.map((block, i) => {
        switch (block.type) {
          case 'heading': {
            const sizes: Record<number, number> = { 1: 18, 2: 16, 3: 14, 4: 13 }
            return (
              <div key={i} style={{
                fontSize: sizes[block.level] || 13,
                fontWeight: 700,
                color: colors.text,
                margin: `${block.level === 1 ? 16 : 12}px 0 6px`,
                paddingBottom: block.level <= 2 ? 4 : 0,
                borderBottom: block.level <= 2 ? `1px solid ${colors.border}` : 'none',
              }}>
                {ri(parseInline(block.text), `h${i}-`)}
              </div>
            )
          }

          case 'code-block':
            return <CodeBlock key={i} lang={block.lang} code={block.code} />

          case 'paragraph':
            return (
              <p key={i} style={{ margin: '6px 0' }}>
                {ri(parseInline(block.text), `p${i}-`)}
              </p>
            )

          case 'list': {
            const Tag = block.ordered ? 'ol' : 'ul'
            return (
              <Tag key={i} style={{
                margin: '6px 0',
                paddingLeft: 22,
                listStyleType: block.ordered ? 'decimal' : 'disc',
              }}>
                {block.items.map((item, j) => (
                  <li key={j} style={{ margin: '3px 0', color: colors.text }}>
                    {ri(parseInline(item), `li${i}-${j}-`)}
                  </li>
                ))}
              </Tag>
            )
          }

          case 'table':
            return (
              <div key={i} style={{
                margin: '8px 0',
                borderRadius: 8,
                overflow: 'hidden',
                border: `1px solid ${colors.border}`,
              }}>
                <table style={{
                  width: '100%',
                  borderCollapse: 'collapse',
                  fontSize: 12,
                  fontFamily: fonts.mono,
                }}>
                  <thead>
                    <tr style={{ background: colors.bgSurface }}>
                      {block.headers.map((h, j) => (
                        <th key={j} style={{
                          padding: '7px 12px',
                          textAlign: block.aligns[j] || 'left',
                          fontWeight: 600,
                          color: colors.text,
                          borderBottom: `1px solid ${colors.border}`,
                          whiteSpace: 'nowrap',
                        }}>
                          {ri(parseInline(h), `th${i}-${j}-`)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, rowIdx) => (
                      <tr
                        key={rowIdx}
                        style={{ background: rowIdx % 2 === 0 ? colors.bgOverlay : 'transparent' }}
                        onMouseEnter={e => { e.currentTarget.style.background = colors.bgSurface }}
                        onMouseLeave={e => { e.currentTarget.style.background = rowIdx % 2 === 0 ? colors.bgOverlay : 'transparent' }}
                      >
                        {row.map((cell, ci) => (
                          <td key={ci} style={{
                            padding: '6px 12px',
                            textAlign: block.aligns[ci] || 'left',
                            color: colors.textSecondary,
                            borderBottom: rowIdx < block.rows.length - 1 ? `1px solid ${colors.border}` : 'none',
                          }}>
                            {ri(parseInline(cell), `td${i}-${rowIdx}-${ci}-`)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )

          case 'hr':
            return <hr key={i} style={{ border: 'none', borderTop: `1px solid ${colors.border}`, margin: '12px 0' }} />

          case 'blockquote':
            return (
              <div key={i} style={{
                margin: '8px 0',
                padding: '6px 14px',
                borderLeft: `3px solid ${colors.purple}`,
                background: `${colors.purple}08`,
                color: colors.textSecondary,
                borderRadius: '0 6px 6px 0',
              }}>
                {ri(parseInline(block.text), `bq${i}-`)}
              </div>
            )

          default:
            return null
        }
      })}
    </div>
  )
}
