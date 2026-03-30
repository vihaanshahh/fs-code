import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { UIMessage } from '../shared/types'

// ── Inline the parser helpers so we can test without importing the whole terminal module ──

const ANSI_RE = /\x1b(?:\[[0-9;?]*[a-zA-Z]|\][^\x07\x1b]*(?:\x07|\x1b\\)|\][^\n]*|[()][0-9A-Z]|\][^\x07]*\x07|P[^\x1b]*\x1b\\|\][^\x1b]*\x1b)/g
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '').replace(/\x0f|\x0e/g, '')
}

const TOOL_RE = /^[\s]*[⏺●◆▶╭─•→›»☐✦⬤]\s*(Read|Edit|Write|MultiEdit|Bash|Grep|Glob|Agent|WebSearch|WebFetch|Skill|NotebookEdit|TodoRead|TodoWrite|AskUserQuestion|Task|Search|ListFiles|LS)\b/
const CLAUDE_PROMPT_RE = /^[❯]\s*$/
const WAITING_RE = /(?:^|\s)(?:Allow .+\?|Approve .+\?|\([Yy]\)es\s*\/\s*\([Nn]\)o|\([Aa]\)llow|\([Dd]\)eny)/

// ══════════════════════════════════════════════════════════════════════════════
// 1. ANSI stripping
// ══════════════════════════════════════════════════════════════════════════════

describe('stripAnsi', () => {
  it('strips basic SGR color codes', () => {
    expect(stripAnsi('\x1b[1;34mhello\x1b[0m')).toBe('hello')
  })

  it('strips 256-color and truecolor sequences', () => {
    expect(stripAnsi('\x1b[38;5;196mred\x1b[0m')).toBe('red')
    expect(stripAnsi('\x1b[38;2;255;0;0mred\x1b[0m')).toBe('red')
  })

  it('strips OSC title sequences (BEL terminated)', () => {
    expect(stripAnsi('\x1b]0;window title\x07text')).toBe('text')
  })

  it('strips OSC title sequences (ST terminated)', () => {
    expect(stripAnsi('\x1b]0;window title\x1b\\text')).toBe('text')
  })

  it('strips OSC hyperlinks', () => {
    // OSC 8 ;; URL ST  text  OSC 8 ;; ST
    const link = '\x1b]8;;https://example.com\x07Click\x1b]8;;\x07'
    expect(stripAnsi(link)).toBe('Click')
  })

  it('strips cursor movement and erase sequences', () => {
    expect(stripAnsi('\x1b[2K\x1b[1Ghello')).toBe('hello')
    expect(stripAnsi('\x1b[?25lhidden\x1b[?25h')).toBe('hidden')
  })

  it('strips character set switching (SI/SO)', () => {
    expect(stripAnsi('\x0fhello\x0e')).toBe('hello')
  })

  it('strips DEC character set designations', () => {
    expect(stripAnsi('\x1b(Bhello')).toBe('hello')
  })

  it('handles multiple interleaved sequences', () => {
    const raw = '\x1b[1m\x1b[34m⏺\x1b[0m \x1b[36mRead\x1b[0m src/main.ts'
    expect(stripAnsi(raw)).toBe('⏺ Read src/main.ts')
  })

  it('preserves unicode bullets and text', () => {
    expect(stripAnsi('⏺ Read file.ts')).toBe('⏺ Read file.ts')
    expect(stripAnsi('● Edit main.ts')).toBe('● Edit main.ts')
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// 2. TOOL_RE matching
// ══════════════════════════════════════════════════════════════════════════════

describe('TOOL_RE', () => {
  // Lines that SHOULD match
  const positives = [
    '⏺ Read src/main.ts',
    '  ⏺ Edit src/app.tsx',
    '● Bash npm test',
    '◆ Grep pattern',
    '▶ Agent subagent',
    '⏺ Write /tmp/out.ts',
    '⏺ MultiEdit src/foo.ts',
    '⏺ WebSearch query',
    '⏺ WebFetch https://example.com',
    '⏺ Skill commit',
    '⏺ NotebookEdit nb.ipynb',
    '⏺ TodoRead',
    '⏺ TodoWrite',
    '⏺ AskUserQuestion',
    '⏺ Task create',
    '⏺ Search foo',
    '⏺ ListFiles *.ts',
    '⏺ LS src/',
    '─ Read src/main.ts',       // box-drawing dash
    '• Bash ls -la',             // bullet
    '→ Grep pattern',            // arrow
    '› Edit file.ts',            // guillemet
    '» Write out.ts',            // double guillemet
  ]

  for (const line of positives) {
    it(`matches: ${JSON.stringify(line)}`, () => {
      expect(TOOL_RE.test(line)).toBe(true)
    })
  }

  // Lines that SHOULD NOT match (assistant prose, etc.)
  const negatives = [
    "I'll Read the file next",
    "Let me Edit that for you",
    "Running Bash command",
    "The Grep tool found 3 results",
    "hello world",
    "",
    "  some indented text",
    "Read",                          // bare tool name without bullet
    "Edit src/main.ts",              // no bullet prefix
  ]

  for (const line of negatives) {
    it(`rejects: ${JSON.stringify(line)}`, () => {
      expect(TOOL_RE.test(line)).toBe(false)
    })
  }

  it('matches after stripping ANSI from real CLI output', () => {
    // Simulate real CLI: bold blue bullet, cyan tool name
    const raw = '\x1b[1m\x1b[34m⏺\x1b[0m \x1b[1m\x1b[36mRead\x1b[0m src/renderer/App.tsx'
    const clean = stripAnsi(raw)
    expect(clean).toBe('⏺ Read src/renderer/App.tsx')
    expect(TOOL_RE.test(clean)).toBe(true)
    expect(clean.match(TOOL_RE)![1]).toBe('Read')
  })

  it('matches after stripping ANSI with dim bullet', () => {
    const raw = '\x1b[2m⏺\x1b[22m \x1b[1mBash\x1b[22m echo hello'
    const clean = stripAnsi(raw)
    expect(TOOL_RE.test(clean)).toBe(true)
    expect(clean.match(TOOL_RE)![1]).toBe('Bash')
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// 3. CLAUDE_PROMPT_RE
// ══════════════════════════════════════════════════════════════════════════════

describe('CLAUDE_PROMPT_RE', () => {
  it('matches bare prompt', () => {
    expect(CLAUDE_PROMPT_RE.test('❯')).toBe(true)
  })

  it('matches prompt with trailing space', () => {
    expect(CLAUDE_PROMPT_RE.test('❯ ')).toBe(true)
  })

  it('matches prompt with non-breaking space', () => {
    expect(CLAUDE_PROMPT_RE.test('❯\u00A0')).toBe(true)
  })

  it('rejects prompt with text after', () => {
    expect(CLAUDE_PROMPT_RE.test('❯ hello')).toBe(false)
  })

  it('rejects non-prompt text', () => {
    expect(CLAUDE_PROMPT_RE.test('hello')).toBe(false)
  })

  it('matches after stripping ANSI', () => {
    const raw = '\x1b[1m\x1b[35m❯\x1b[0m '
    expect(CLAUDE_PROMPT_RE.test(stripAnsi(raw))).toBe(true)
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// 4. WAITING_RE (permission prompts)
// ══════════════════════════════════════════════════════════════════════════════

describe('WAITING_RE', () => {
  it('matches Allow tool? prompt', () => {
    expect(WAITING_RE.test('Allow Read?')).toBe(true)
    expect(WAITING_RE.test('Allow Bash(npm test)?')).toBe(true)
  })

  it('matches Yes/No prompt', () => {
    expect(WAITING_RE.test('(Y)es / (N)o')).toBe(true)
  })

  it('matches (A)llow / (D)eny style', () => {
    expect(WAITING_RE.test('(A)llow')).toBe(true)
    expect(WAITING_RE.test('(D)eny')).toBe(true)
  })

  it('rejects normal text', () => {
    expect(WAITING_RE.test('The tool completed successfully')).toBe(false)
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// 5. End-to-end: feed raw CLI chunks through strip + regex pipeline
// ══════════════════════════════════════════════════════════════════════════════

describe('end-to-end pipeline', () => {
  // Simulate what TerminalPhaseParser.feed() does: buffer → split lines → strip → match
  function parseLine(rawLine: string): { type: 'tool'; name: string } | { type: 'prompt' } | { type: 'waiting' } | { type: 'text'; text: string } {
    const clean = stripAnsi(rawLine).replace(/\u00A0/g, ' ').trim()
    if (!clean) return { type: 'text', text: '' }

    const toolMatch = clean.match(TOOL_RE)
    if (toolMatch) return { type: 'tool', name: toolMatch[1] }
    if (CLAUDE_PROMPT_RE.test(clean)) return { type: 'prompt' }
    if (WAITING_RE.test(clean)) return { type: 'waiting' }
    return { type: 'text', text: clean }
  }

  it('detects Read tool from colored output', () => {
    const raw = '\x1b[1;34m⏺\x1b[0m \x1b[1;36mRead\x1b[0m src/main/index.ts'
    expect(parseLine(raw)).toEqual({ type: 'tool', name: 'Read' })
  })

  it('detects Bash tool from colored output', () => {
    const raw = '\x1b[34m⏺\x1b[0m \x1b[36mBash\x1b[0m npm run build'
    expect(parseLine(raw)).toEqual({ type: 'tool', name: 'Bash' })
  })

  it('detects Edit tool', () => {
    const raw = '\x1b[34m⏺\x1b[0m \x1b[36mEdit\x1b[0m src/renderer/App.tsx'
    expect(parseLine(raw)).toEqual({ type: 'tool', name: 'Edit' })
  })

  it('detects Grep tool', () => {
    const raw = '\x1b[34m⏺\x1b[0m \x1b[36mGrep\x1b[0m pattern in src/'
    expect(parseLine(raw)).toEqual({ type: 'tool', name: 'Grep' })
  })

  it('detects prompt after ANSI', () => {
    const raw = '\x1b[1;35m❯\x1b[0m '
    expect(parseLine(raw)).toEqual({ type: 'prompt' })
  })

  it('detects permission prompt', () => {
    const raw = '\x1b[33mAllow Bash(rm -rf node_modules)?\x1b[0m'
    expect(parseLine(raw)).toEqual({ type: 'waiting' })
  })

  it('classifies assistant prose as text', () => {
    const raw = "\x1b[0mI'll Read the file and then Edit it for you."
    const result = parseLine(raw)
    expect(result.type).toBe('text')
  })

  it('handles multi-sequence tool line', () => {
    // Bold + color on bullet, bold + different color on tool, reset + path
    const raw = '\x1b[1m\x1b[38;5;75m⏺\x1b[0m \x1b[1m\x1b[38;5;81mWrite\x1b[0m /tmp/output.ts'
    expect(parseLine(raw)).toEqual({ type: 'tool', name: 'Write' })
  })

  it('handles Agent tool with sub-description', () => {
    const raw = '\x1b[34m⏺\x1b[0m \x1b[36mAgent\x1b[0m (search codebase for...'
    expect(parseLine(raw)).toEqual({ type: 'tool', name: 'Agent' })
  })
})
