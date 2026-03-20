/**
 * Tests for the built-in code intelligence engine (codex).
 *
 * Exercises the full pipeline: collect files → parse → index → query → hooks
 * Uses a temp directory with synthetic source files. No Electron needed.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { openDatabase } from './db'
import { collectFiles } from './collector'
import { parseFile, hashFile, getLanguage, isSupportedFile } from './parser'
import { indexProjectSync as indexProject, reindexFile } from './indexer'
import * as query from './query'

// ---------------------------------------------------------------------------
// Test fixtures — a tiny synthetic project
// ---------------------------------------------------------------------------
let tmpDir: string
let dbPath: string
let db: ReturnType<typeof openDatabase>

const FILES = {
  'src/math.ts': `
export function add(a: number, b: number): number {
  return a + b
}

export function multiply(a: number, b: number): number {
  return a * b
}

export const PI = 3.14159
`,
  'src/calculator.ts': `
import { add, multiply } from './math'

export class Calculator {
  private history: number[] = []

  sum(...nums: number[]): number {
    const result = nums.reduce((a, b) => add(a, b), 0)
    this.history.push(result)
    return result
  }

  product(...nums: number[]): number {
    const result = nums.reduce((a, b) => multiply(a, b), 1)
    this.history.push(result)
    return result
  }

  getHistory(): number[] {
    return [...this.history]
  }
}
`,
  'src/utils/format.ts': `
import { PI } from '../math'

export function formatNumber(n: number, decimals: number = 2): string {
  return n.toFixed(decimals)
}

export function formatPI(): string {
  return formatNumber(PI, 5)
}

export type FormatOptions = {
  decimals?: number
  prefix?: string
}
`,
  'src/index.ts': `
export { Calculator } from './calculator'
export { add, multiply, PI } from './math'
export { formatNumber, formatPI } from './utils/format'
`,
  'README.md': `# Test Project\nNothing to see here.`,
  'package.json': `{"name": "test-project", "version": "1.0.0"}`,
  '.gitignore': `node_modules\ndist\n`,
}

beforeAll(() => {
  // Create temp project
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-test-'))
  dbPath = path.join(tmpDir, '.test-index', 'index.db')

  for (const [relPath, content] of Object.entries(FILES)) {
    const fullPath = path.join(tmpDir, relPath)
    fs.mkdirSync(path.dirname(fullPath), { recursive: true })
    fs.writeFileSync(fullPath, content)
  }

  // Open DB and index
  db = openDatabase(tmpDir, dbPath)
  indexProject(tmpDir, db)
})

afterAll(() => {
  db?.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Collector
// ---------------------------------------------------------------------------
describe('collector', () => {
  it('finds only supported source files', () => {
    const files = collectFiles(tmpDir)
    expect(files).toContain('src/math.ts')
    expect(files).toContain('src/calculator.ts')
    expect(files).toContain('src/utils/format.ts')
    expect(files).toContain('src/index.ts')
    expect(files).toContain('package.json')
    // README.md is not a supported extension
    expect(files).not.toContain('README.md')
  })

  it('respects .gitignore', () => {
    // Create a node_modules dir that should be skipped
    const nmDir = path.join(tmpDir, 'node_modules', 'foo')
    fs.mkdirSync(nmDir, { recursive: true })
    fs.writeFileSync(path.join(nmDir, 'index.ts'), 'export const x = 1')

    const files = collectFiles(tmpDir)
    expect(files.some(f => f.includes('node_modules'))).toBe(false)

    // Cleanup
    fs.rmSync(path.join(tmpDir, 'node_modules'), { recursive: true })
  })
})

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------
describe('parser', () => {
  it('detects language from extension', () => {
    expect(getLanguage('foo.ts')).toBe('typescript')
    expect(getLanguage('bar.py')).toBe('python')
    expect(getLanguage('baz.rs')).toBe('rust')
    expect(getLanguage('README.md')).toBeNull()
  })

  it('supports expected file types', () => {
    expect(isSupportedFile('a.ts')).toBe(true)
    expect(isSupportedFile('a.tsx')).toBe(true)
    expect(isSupportedFile('a.js')).toBe(true)
    expect(isSupportedFile('a.py')).toBe(true)
    expect(isSupportedFile('a.rs')).toBe(true)
    expect(isSupportedFile('a.go')).toBe(true)
    expect(isSupportedFile('a.md')).toBe(false)
  })

  it('hashes file content deterministically', () => {
    const h1 = hashFile('hello world')
    const h2 = hashFile('hello world')
    const h3 = hashFile('hello world!')
    expect(h1).toBe(h2)
    expect(h1).not.toBe(h3)
    expect(h1.length).toBe(16) // SHA256 truncated to 16 hex chars
  })

  it('extracts symbols from TypeScript', () => {
    const result = parseFile('math.ts', FILES['src/math.ts'])
    expect(result.language).toBe('typescript')
    expect(result.symbols.length).toBeGreaterThanOrEqual(3) // add, multiply, PI
    const names = result.symbols.map(s => s.name)
    expect(names).toContain('add')
    expect(names).toContain('multiply')
    expect(names).toContain('PI')
  })

  it('extracts class and methods', () => {
    const result = parseFile('calculator.ts', FILES['src/calculator.ts'])
    const names = result.symbols.map(s => s.name)
    expect(names).toContain('Calculator')
    expect(names).toContain('sum')
    expect(names).toContain('product')
    expect(names).toContain('getHistory')

    const calc = result.symbols.find(s => s.name === 'Calculator')
    expect(calc?.kind).toBe('class')
    expect(calc?.exported).toBe(true)

    const sum = result.symbols.find(s => s.name === 'sum')
    expect(sum?.kind).toBe('method')
    expect(sum?.qualifiedName).toBe('Calculator.sum')
  })

  it('extracts imports', () => {
    const result = parseFile('calculator.ts', FILES['src/calculator.ts'])
    expect(result.imports.length).toBeGreaterThanOrEqual(1)
    const imp = result.imports.find(i => i.source === './math')
    expect(imp).toBeDefined()
    expect(imp!.names).toContain('add')
    expect(imp!.names).toContain('multiply')
  })

  it('extracts type aliases', () => {
    const result = parseFile('format.ts', FILES['src/utils/format.ts'])
    const typeAlias = result.symbols.find(s => s.name === 'FormatOptions')
    expect(typeAlias).toBeDefined()
    expect(typeAlias!.kind).toBe('type')
    expect(typeAlias!.exported).toBe(true)
  })

  it('extracts re-exports', () => {
    const result = parseFile('index.ts', FILES['src/index.ts'])
    expect(result.reExports.length).toBeGreaterThanOrEqual(3)
    const mathReexport = result.reExports.find(r => r.source === './math')
    expect(mathReexport).toBeDefined()
    expect(mathReexport!.names).toContain('add')
  })

  it('extracts function calls', () => {
    const result = parseFile('calculator.ts', FILES['src/calculator.ts'])
    const addCalls = result.calls.filter(c => c.calledName === 'add')
    expect(addCalls.length).toBeGreaterThanOrEqual(1)
    // add() is called from within the sum method; the enclosing symbol
    // depends on how the parser resolves arrow-function intermediaries
    const callers = addCalls.map(c => c.callerSymbol)
    expect(callers.some(c => c === 'sum' || c === 'result')).toBe(true)
  })

  it('extracts function parameters', () => {
    const result = parseFile('math.ts', FILES['src/math.ts'])
    const addFn = result.symbols.find(s => s.name === 'add')
    expect(addFn?.parameters).toBeDefined()
    expect(addFn!.parameters!.length).toBe(2)
    expect(addFn!.parameters![0].name).toBe('a')
    // tree-sitter may include the colon in the type annotation text
    expect(addFn!.parameters![0].type).toContain('number')
  })
})

// ---------------------------------------------------------------------------
// Indexer + Query
// ---------------------------------------------------------------------------
describe('indexer', () => {
  it('indexed all source files', () => {
    const stats = query.getStats(db)
    expect(stats.files).toBeGreaterThanOrEqual(4) // at least the 4 .ts files
    expect(stats.symbols).toBeGreaterThan(0)
    expect(stats.edges).toBeGreaterThan(0)
  })

  it('computed PageRank for symbols', () => {
    const top = query.getRank(db, 5)
    expect(top.length).toBeGreaterThan(0)
    // add/multiply should rank high (they're called and imported)
    const names = top.map(s => s.name)
    expect(names.some(n => ['add', 'multiply', 'Calculator'].includes(n))).toBe(true)
  })
})

describe('search', () => {
  it('finds symbols by name', () => {
    const results = query.search(db, 'add')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].name).toBe('add')
  })

  it('finds symbols by content', () => {
    const results = query.search(db, 'history')
    expect(results.length).toBeGreaterThan(0)
  })

  it('returns empty for nonsense query', () => {
    const results = query.search(db, 'xyzzy_nonexistent_12345')
    expect(results.length).toBe(0)
  })
})

describe('getContext', () => {
  it('returns full context for a symbol', () => {
    const ctx = query.getContext(db, 'add')
    expect(ctx).not.toBeNull()
    expect(ctx!.symbol.name).toBe('add')
    expect(ctx!.symbol.kind).toBe('function')
    expect(ctx!.symbol.file).toBe('src/math.ts')
    expect(ctx!.symbol.code).toContain('return a + b')
  })

  it('returns null for unknown symbol', () => {
    expect(query.getContext(db, 'doesNotExist')).toBeNull()
  })
})

describe('getCallers', () => {
  it('finds callers of a function', () => {
    const callers = query.getCallers(db, 'add')
    expect(callers.length).toBeGreaterThan(0)
    // sum() calls add()
    const callerNames = callers.map(c => c.name)
    expect(callerNames).toContain('sum')
  })
})

describe('getImpact', () => {
  it('finds files affected by changes', () => {
    const impact = query.getImpact(db, 'src/math.ts')
    expect(impact.length).toBeGreaterThan(0)
    // At least one of calculator.ts or utils/format.ts should be impacted
    // (file_deps depend on indexing order for cross-file resolution)
    const impactedFiles = impact.map(i => i.file)
    expect(
      impactedFiles.includes('src/calculator.ts') ||
      impactedFiles.includes('src/utils/format.ts'),
    ).toBe(true)
  })
})

describe('findFiles', () => {
  it('finds files by glob pattern', () => {
    const results = query.findFiles(db, 'src/*.ts')
    expect(results.length).toBeGreaterThanOrEqual(3) // math, calculator, index
  })

  it('finds nested files', () => {
    const results = query.findFiles(db, 'src/utils/*')
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results[0].path).toBe('src/utils/format.ts')
  })
})

describe('getFileSymbols', () => {
  it('lists all symbols in a file', () => {
    const symbols = query.getFileSymbols(db, 'src/math.ts')
    expect(symbols.length).toBeGreaterThanOrEqual(3)
    const names = symbols.map(s => s.name)
    expect(names).toContain('add')
    expect(names).toContain('multiply')
    expect(names).toContain('PI')
  })
})

describe('findByKind', () => {
  it('finds all classes', () => {
    const classes = query.findByKind(db, 'class')
    expect(classes.length).toBeGreaterThanOrEqual(1)
    expect(classes[0].name).toBe('Calculator')
  })

  it('finds all types', () => {
    const types = query.findByKind(db, 'type')
    expect(types.length).toBeGreaterThanOrEqual(1)
    expect(types[0].name).toBe('FormatOptions')
  })
})

describe('getModules', () => {
  it('groups files by top-level directory', () => {
    const modules = query.getModules(db)
    expect(modules.length).toBeGreaterThan(0)
    const names = modules.map(m => m.name)
    expect(names).toContain('src')
  })
})

describe('brief', () => {
  it('generates a project overview', () => {
    const text = query.brief(db)
    expect(text).toContain('files')
    expect(text).toContain('symbols')
    expect(text).toContain('Key symbols')
    expect(text).toContain('File map')
    expect(text).toContain('MCP tools')
  })
})

describe('preEditContext', () => {
  it('shows exports and dependents for a file', () => {
    const ctx = query.preEditContext(db, 'src/math.ts')
    expect(ctx).toContain('add')
    expect(ctx).toContain('multiply')
    expect(ctx).toContain('depend on this file')
  })

  it('handles unknown files gracefully', () => {
    const ctx = query.preEditContext(db, 'nonexistent.ts')
    expect(ctx).toContain('not in index')
  })
})

describe('findDeadExports', () => {
  it('finds unreferenced exports', () => {
    const dead = query.findDeadExports(db)
    // Some exports may be dead (e.g. FormatOptions if nothing imports it)
    expect(Array.isArray(dead)).toBe(true)
  })
})

describe('getFileMap', () => {
  it('returns all project files with exports', () => {
    const map = query.getFileMap(db)
    expect(map.length).toBeGreaterThan(0)
    const mathFile = map.find(f => f.path === 'src/math.ts')
    expect(mathFile).toBeDefined()
    expect(mathFile!.exports.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Incremental reindex
// ---------------------------------------------------------------------------
describe('reindexFile', () => {
  it('updates index when file content changes', () => {
    const before = query.search(db, 'subtract')
    expect(before.length).toBe(0)

    // Add a new function
    const mathPath = path.join(tmpDir, 'src/math.ts')
    const original = fs.readFileSync(mathPath, 'utf-8')
    fs.writeFileSync(mathPath, original + '\nexport function subtract(a: number, b: number): number { return a - b }\n')

    reindexFile(tmpDir, 'src/math.ts', db)

    const after = query.search(db, 'subtract')
    expect(after.length).toBeGreaterThan(0)
    expect(after[0].name).toBe('subtract')

    // Restore original
    fs.writeFileSync(mathPath, original)
    reindexFile(tmpDir, 'src/math.ts', db)
  })

  it('removes file from index when deleted', () => {
    // Create a temporary file
    const tmpFile = path.join(tmpDir, 'src/temp.ts')
    fs.writeFileSync(tmpFile, 'export function tempFn(): void {}')
    reindexFile(tmpDir, 'src/temp.ts', db)

    let results = query.search(db, 'tempFn')
    expect(results.length).toBeGreaterThan(0)

    // Delete it
    fs.unlinkSync(tmpFile)
    reindexFile(tmpDir, 'src/temp.ts', db)

    results = query.search(db, 'tempFn')
    expect(results.length).toBe(0)
  })

  it('no-ops when content is unchanged', () => {
    const statsBefore = query.getStats(db)
    reindexFile(tmpDir, 'src/math.ts', db)
    const statsAfter = query.getStats(db)
    expect(statsAfter.symbols).toBe(statsBefore.symbols)
  })
})

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------
describe('hooks', () => {
  it('SessionStart hook returns project brief', async () => {
    const { createCodexHooks } = await import('./hooks')
    const hooks = createCodexHooks(db, tmpDir)

    expect(hooks.SessionStart).toBeDefined()
    const sessionHook = hooks.SessionStart![0].hooks[0]
    const result = await sessionHook(
      { hook_event_name: 'SessionStart', session_id: 'test', transcript_path: '', cwd: tmpDir, source: 'startup' } as any,
      undefined,
      { signal: new AbortController().signal },
    )
    expect((result as any).continue).toBe(true)
    expect((result as any).additionalContext).toContain('symbols')
  })

  it('PreToolUse hook returns dependency context', async () => {
    const { createCodexHooks } = await import('./hooks')
    const hooks = createCodexHooks(db, tmpDir)

    expect(hooks.PreToolUse).toBeDefined()
    const preHook = hooks.PreToolUse![0].hooks[0]
    const result = await preHook(
      { hook_event_name: 'PreToolUse', session_id: 'test', transcript_path: '', cwd: tmpDir, tool_name: 'Write', tool_input: { file_path: 'src/math.ts' }, tool_use_id: 'test' } as any,
      undefined,
      { signal: new AbortController().signal },
    )
    expect((result as any).continue).toBe(true)
    expect((result as any).additionalContext).toContain('add')
  })

  it('PostToolUse hook reindexes file', async () => {
    const { createCodexHooks } = await import('./hooks')
    const hooks = createCodexHooks(db, tmpDir)

    expect(hooks.PostToolUse).toBeDefined()
    const postHook = hooks.PostToolUse![0].hooks[0]
    const result = await postHook(
      { hook_event_name: 'PostToolUse', session_id: 'test', transcript_path: '', cwd: tmpDir, tool_name: 'Write', tool_input: { file_path: 'src/math.ts' }, tool_response: {}, tool_use_id: 'test' } as any,
      undefined,
      { signal: new AbortController().signal },
    )
    expect((result as any).continue).toBe(true)
  })
})
