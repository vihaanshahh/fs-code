import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import {
  openDatabase,
  getOrCreateFile,
  clearFileData,
  insertSymbol,
  insertEdge,
  insertPkgDep,
  insertFileDep,
  insertTypeRelation,
  removeStaleFiles,
  removeFile,
} from './db'
import type Database from 'better-sqlite3'

let db: Database.Database
let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-db-test-'))
  const dbPath = path.join(tmpDir, 'test.db')
  db = openDatabase('/fake/root', dbPath)
})

afterEach(() => {
  db.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

// ── Database setup ──────────────────────────────────────────────────

describe('openDatabase', () => {
  it('creates DB with all expected tables', () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[]
    const names = tables.map(t => t.name).filter(n => !n.startsWith('sqlite_') && !n.startsWith('symbols_fts'))
    expect(names).toContain('files')
    expect(names).toContain('symbols')
    expect(names).toContain('edges')
    expect(names).toContain('file_deps')
    expect(names).toContain('pkg_deps')
    expect(names).toContain('type_relations')
    expect(names).toContain('rankings')
  })

  it('creates symbols_fts virtual table', () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='symbols_fts'")
      .all()
    expect(tables).toHaveLength(1)
  })

  it('enables WAL mode', () => {
    const mode = db.pragma('journal_mode', { simple: true }) as string
    expect(mode.toLowerCase()).toBe('wal')
  })

  it('enables foreign keys', () => {
    const fk = db.pragma('foreign_keys', { simple: true }) as number
    expect(fk).toBe(1)
  })

  it('can be opened twice on the same path without error', () => {
    const dbPath2 = path.join(tmpDir, 'test2.db')
    const db2 = openDatabase('/fake/root2', dbPath2)
    expect(db2).toBeDefined()
    db2.close()
  })
})

// ── getOrCreateFile ─────────────────────────────────────────────────

describe('getOrCreateFile', () => {
  it('new file → {id, changed: true}', () => {
    const rec = getOrCreateFile(db, 'src/foo.ts', 'hash1', 'typescript', 10)
    expect(rec.id).toBeGreaterThan(0)
    expect(rec.changed).toBe(true)
  })

  it('same file same hash → {id, changed: false}', () => {
    const rec1 = getOrCreateFile(db, 'src/foo.ts', 'hash1', 'typescript', 10)
    const rec2 = getOrCreateFile(db, 'src/foo.ts', 'hash1', 'typescript', 10)
    expect(rec2.id).toBe(rec1.id)
    expect(rec2.changed).toBe(false)
  })

  it('same file different hash → {id, changed: true}', () => {
    const rec1 = getOrCreateFile(db, 'src/foo.ts', 'hash1', 'typescript', 10)
    const rec2 = getOrCreateFile(db, 'src/foo.ts', 'hash2', 'typescript', 12)
    expect(rec2.id).toBe(rec1.id)
    expect(rec2.changed).toBe(true)
  })

  it('unique path constraint — different paths → different IDs', () => {
    const r1 = getOrCreateFile(db, 'a.ts', 'h1', 'typescript', 1)
    const r2 = getOrCreateFile(db, 'b.ts', 'h2', 'typescript', 1)
    expect(r1.id).not.toBe(r2.id)
  })

  it('stores language and lineCount', () => {
    getOrCreateFile(db, 'x.py', 'h', 'python', 42)
    const row = db.prepare('SELECT language, line_count FROM files WHERE path = ?').get('x.py') as {
      language: string
      line_count: number
    }
    expect(row.language).toBe('python')
    expect(row.line_count).toBe(42)
  })

  it('stores lastModified when provided', () => {
    const ts = 1700000000
    getOrCreateFile(db, 'y.ts', 'h', 'typescript', 5, ts)
    const row = db.prepare('SELECT last_modified FROM files WHERE path = ?').get('y.ts') as {
      last_modified: number
    }
    expect(row.last_modified).toBe(ts)
  })

  it('auto-populates lastModified when not provided', () => {
    const before = Date.now()
    getOrCreateFile(db, 'z.ts', 'h', 'typescript', 5)
    const row = db.prepare('SELECT last_modified FROM files WHERE path = ?').get('z.ts') as {
      last_modified: number
    }
    expect(row.last_modified).toBeGreaterThanOrEqual(before)
  })
})

// ── insertSymbol / clearFileData ────────────────────────────────────

describe('insertSymbol', () => {
  it('returns auto-increment ID', () => {
    const file = getOrCreateFile(db, 'a.ts', 'h', 'typescript', 10)
    const id1 = insertSymbol(db, file.id, { name: 'foo', kind: 'function', lineStart: 1, lineEnd: 5 })
    const id2 = insertSymbol(db, file.id, { name: 'bar', kind: 'function', lineStart: 6, lineEnd: 10 })
    expect(id1).toBeGreaterThan(0)
    expect(id2).toBe(id1 + 1)
  })

  it('insert with all optional fields', () => {
    const file = getOrCreateFile(db, 'a.ts', 'h', 'typescript', 10)
    const id = insertSymbol(db, file.id, {
      name: 'MyClass',
      qualifiedName: 'module.MyClass',
      kind: 'class',
      lineStart: 1,
      lineEnd: 50,
      signature: 'class MyClass {}',
      docstring: 'A class',
      content: 'class MyClass { ... }',
      contentHash: 'abcdef',
      exported: true,
      parameters: '(a: string, b: number)',
    })
    const row = db.prepare('SELECT * FROM symbols WHERE id = ?').get(id) as Record<string, unknown>
    expect(row.name).toBe('MyClass')
    expect(row.qualified_name).toBe('module.MyClass')
    expect(row.signature).toBe('class MyClass {}')
    expect(row.exported).toBe(1)
    expect(row.parameters).toBe('(a: string, b: number)')
  })

  it('insert with minimal fields', () => {
    const file = getOrCreateFile(db, 'a.ts', 'h', 'typescript', 10)
    const id = insertSymbol(db, file.id, { name: 'x', kind: 'variable', lineStart: 1, lineEnd: 1 })
    expect(id).toBeGreaterThan(0)
    const row = db.prepare('SELECT * FROM symbols WHERE id = ?').get(id) as Record<string, unknown>
    expect(row.signature).toBeNull()
    expect(row.docstring).toBeNull()
    expect(row.exported).toBe(0)
  })
})

describe('clearFileData', () => {
  it('removes all symbols for a file', () => {
    const file = getOrCreateFile(db, 'a.ts', 'h', 'typescript', 10)
    insertSymbol(db, file.id, { name: 'foo', kind: 'function', lineStart: 1, lineEnd: 5 })
    insertSymbol(db, file.id, { name: 'bar', kind: 'function', lineStart: 6, lineEnd: 10 })

    clearFileData(db, file.id)

    const count = db.prepare('SELECT COUNT(*) as c FROM symbols WHERE file_id = ?').get(file.id) as { c: number }
    expect(count.c).toBe(0)
  })

  it('removes edges involving file symbols', () => {
    const f1 = getOrCreateFile(db, 'a.ts', 'h', 'typescript', 10)
    const f2 = getOrCreateFile(db, 'b.ts', 'h', 'typescript', 10)
    const s1 = insertSymbol(db, f1.id, { name: 'foo', kind: 'function', lineStart: 1, lineEnd: 5 })
    const s2 = insertSymbol(db, f2.id, { name: 'bar', kind: 'function', lineStart: 1, lineEnd: 5 })
    insertEdge(db, s1, s2, 'call')

    clearFileData(db, f1.id)

    const edges = db.prepare('SELECT COUNT(*) as c FROM edges').get() as { c: number }
    expect(edges.c).toBe(0)
  })

  it('removes pkg_deps for the file', () => {
    const file = getOrCreateFile(db, 'a.ts', 'h', 'typescript', 10)
    insertPkgDep(db, file.id, 'react', 'useState')

    clearFileData(db, file.id)

    const count = db.prepare('SELECT COUNT(*) as c FROM pkg_deps WHERE file_id = ?').get(file.id) as { c: number }
    expect(count.c).toBe(0)
  })

  it('removes file_deps from the file', () => {
    const f1 = getOrCreateFile(db, 'a.ts', 'h', 'typescript', 10)
    const f2 = getOrCreateFile(db, 'b.ts', 'h', 'typescript', 10)
    insertFileDep(db, f1.id, f2.id, 'import', './b')

    clearFileData(db, f1.id)

    const count = db.prepare('SELECT COUNT(*) as c FROM file_deps WHERE from_file = ?').get(f1.id) as { c: number }
    expect(count.c).toBe(0)
  })

  it('removes type_relations for file symbols', () => {
    const file = getOrCreateFile(db, 'a.ts', 'h', 'typescript', 10)
    const sym = insertSymbol(db, file.id, { name: 'Child', kind: 'class', lineStart: 1, lineEnd: 10 })
    insertTypeRelation(db, sym, 'Parent', 'extends')

    clearFileData(db, file.id)

    const count = db.prepare('SELECT COUNT(*) as c FROM type_relations').get() as { c: number }
    expect(count.c).toBe(0)
  })

  it('removes rankings for file symbols', () => {
    const file = getOrCreateFile(db, 'a.ts', 'h', 'typescript', 10)
    const sym = insertSymbol(db, file.id, { name: 'foo', kind: 'function', lineStart: 1, lineEnd: 5 })
    db.prepare('INSERT INTO rankings (symbol_id, pagerank, in_degree, out_degree) VALUES (?, 0.5, 2, 3)').run(sym)

    clearFileData(db, file.id)

    const count = db.prepare('SELECT COUNT(*) as c FROM rankings').get() as { c: number }
    expect(count.c).toBe(0)
  })

  it('does not remove other files data', () => {
    const f1 = getOrCreateFile(db, 'a.ts', 'h', 'typescript', 10)
    const f2 = getOrCreateFile(db, 'b.ts', 'h', 'typescript', 10)
    insertSymbol(db, f1.id, { name: 'foo', kind: 'function', lineStart: 1, lineEnd: 5 })
    insertSymbol(db, f2.id, { name: 'bar', kind: 'function', lineStart: 1, lineEnd: 5 })

    clearFileData(db, f1.id)

    const count = db.prepare('SELECT COUNT(*) as c FROM symbols WHERE file_id = ?').get(f2.id) as { c: number }
    expect(count.c).toBe(1)
  })
})

// ── insertEdge ──────────────────────────────────────────────────────

describe('insertEdge', () => {
  it('insert edge with line number', () => {
    const file = getOrCreateFile(db, 'a.ts', 'h', 'typescript', 10)
    const s1 = insertSymbol(db, file.id, { name: 'a', kind: 'function', lineStart: 1, lineEnd: 5 })
    const s2 = insertSymbol(db, file.id, { name: 'b', kind: 'function', lineStart: 6, lineEnd: 10 })
    insertEdge(db, s1, s2, 'call', 3)

    const edge = db.prepare('SELECT * FROM edges WHERE from_id = ? AND to_id = ?').get(s1, s2) as Record<string, unknown>
    expect(edge.kind).toBe('call')
    expect(edge.line).toBe(3)
  })

  it('insert edge without line number', () => {
    const file = getOrCreateFile(db, 'a.ts', 'h', 'typescript', 10)
    const s1 = insertSymbol(db, file.id, { name: 'a', kind: 'function', lineStart: 1, lineEnd: 5 })
    const s2 = insertSymbol(db, file.id, { name: 'b', kind: 'function', lineStart: 6, lineEnd: 10 })
    insertEdge(db, s1, s2, 'import')

    const edge = db.prepare('SELECT * FROM edges WHERE from_id = ? AND to_id = ?').get(s1, s2) as Record<string, unknown>
    expect(edge.kind).toBe('import')
    expect(edge.line).toBeNull()
  })

  it('duplicate edge is ignored (INSERT OR IGNORE)', () => {
    const file = getOrCreateFile(db, 'a.ts', 'h', 'typescript', 10)
    const s1 = insertSymbol(db, file.id, { name: 'a', kind: 'function', lineStart: 1, lineEnd: 5 })
    const s2 = insertSymbol(db, file.id, { name: 'b', kind: 'function', lineStart: 6, lineEnd: 10 })
    insertEdge(db, s1, s2, 'call')
    insertEdge(db, s1, s2, 'call') // duplicate — should not throw

    const count = db.prepare('SELECT COUNT(*) as c FROM edges').get() as { c: number }
    expect(count.c).toBe(1)
  })
})

// ── insertPkgDep / insertFileDep / insertTypeRelation ───────────────

describe('insertPkgDep', () => {
  it('basic insert and retrieval', () => {
    const file = getOrCreateFile(db, 'a.ts', 'h', 'typescript', 10)
    insertPkgDep(db, file.id, 'react', 'useState,useEffect')

    const row = db.prepare('SELECT * FROM pkg_deps WHERE file_id = ?').get(file.id) as Record<string, unknown>
    expect(row.package).toBe('react')
    expect(row.imported_names).toBe('useState,useEffect')
  })

  it('duplicate is ignored', () => {
    const file = getOrCreateFile(db, 'a.ts', 'h', 'typescript', 10)
    insertPkgDep(db, file.id, 'react', 'useState')
    insertPkgDep(db, file.id, 'react', 'useState') // duplicate

    const count = db.prepare('SELECT COUNT(*) as c FROM pkg_deps WHERE file_id = ?').get(file.id) as { c: number }
    expect(count.c).toBe(1)
  })
})

describe('insertFileDep', () => {
  it('basic insert and retrieval', () => {
    const f1 = getOrCreateFile(db, 'a.ts', 'h', 'typescript', 10)
    const f2 = getOrCreateFile(db, 'b.ts', 'h', 'typescript', 10)
    insertFileDep(db, f1.id, f2.id, 'import', './b')

    const row = db.prepare('SELECT * FROM file_deps WHERE from_file = ?').get(f1.id) as Record<string, unknown>
    expect(row.to_file).toBe(f2.id)
    expect(row.kind).toBe('import')
    expect(row.import_name).toBe('./b')
  })

  it('duplicate is ignored', () => {
    const f1 = getOrCreateFile(db, 'a.ts', 'h', 'typescript', 10)
    const f2 = getOrCreateFile(db, 'b.ts', 'h', 'typescript', 10)
    insertFileDep(db, f1.id, f2.id, 'import', './b')
    insertFileDep(db, f1.id, f2.id, 'import', './b') // duplicate

    const count = db.prepare('SELECT COUNT(*) as c FROM file_deps WHERE from_file = ?').get(f1.id) as { c: number }
    expect(count.c).toBe(1)
  })
})

describe('insertTypeRelation', () => {
  it('basic insert and retrieval', () => {
    const file = getOrCreateFile(db, 'a.ts', 'h', 'typescript', 10)
    const sym = insertSymbol(db, file.id, { name: 'Child', kind: 'class', lineStart: 1, lineEnd: 10 })
    insertTypeRelation(db, sym, 'Parent', 'extends')

    const row = db.prepare('SELECT * FROM type_relations WHERE child_id = ?').get(sym) as Record<string, unknown>
    expect(row.parent_name).toBe('Parent')
    expect(row.kind).toBe('extends')
  })

  it('duplicate is ignored', () => {
    const file = getOrCreateFile(db, 'a.ts', 'h', 'typescript', 10)
    const sym = insertSymbol(db, file.id, { name: 'Child', kind: 'class', lineStart: 1, lineEnd: 10 })
    insertTypeRelation(db, sym, 'Parent', 'extends')
    insertTypeRelation(db, sym, 'Parent', 'extends') // duplicate

    const count = db.prepare('SELECT COUNT(*) as c FROM type_relations WHERE child_id = ?').get(sym) as { c: number }
    expect(count.c).toBe(1)
  })

  it('same child can have multiple parents', () => {
    const file = getOrCreateFile(db, 'a.ts', 'h', 'typescript', 10)
    const sym = insertSymbol(db, file.id, { name: 'Child', kind: 'class', lineStart: 1, lineEnd: 10 })
    insertTypeRelation(db, sym, 'Parent', 'extends')
    insertTypeRelation(db, sym, 'Serializable', 'implements')

    const count = db.prepare('SELECT COUNT(*) as c FROM type_relations WHERE child_id = ?').get(sym) as { c: number }
    expect(count.c).toBe(2)
  })
})

// ── removeStaleFiles / removeFile ───────────────────────────────────

describe('removeStaleFiles', () => {
  it('removes files not in valid set', () => {
    getOrCreateFile(db, 'a.ts', 'h1', 'typescript', 10)
    getOrCreateFile(db, 'b.ts', 'h2', 'typescript', 10)
    getOrCreateFile(db, 'c.ts', 'h3', 'typescript', 10)

    const removed = removeStaleFiles(db, new Set(['a.ts', 'c.ts']))
    expect(removed).toBe(1)

    const remaining = db.prepare('SELECT path FROM files ORDER BY path').all() as { path: string }[]
    expect(remaining.map(r => r.path)).toEqual(['a.ts', 'c.ts'])
  })

  it('returns correct removed count', () => {
    getOrCreateFile(db, 'a.ts', 'h1', 'typescript', 10)
    getOrCreateFile(db, 'b.ts', 'h2', 'typescript', 10)

    const removed = removeStaleFiles(db, new Set())
    expect(removed).toBe(2)
  })

  it('removes 0 when all files are valid', () => {
    getOrCreateFile(db, 'a.ts', 'h1', 'typescript', 10)
    const removed = removeStaleFiles(db, new Set(['a.ts']))
    expect(removed).toBe(0)
  })

  it('cleans up associated symbols', () => {
    const file = getOrCreateFile(db, 'a.ts', 'h', 'typescript', 10)
    insertSymbol(db, file.id, { name: 'foo', kind: 'function', lineStart: 1, lineEnd: 5 })

    removeStaleFiles(db, new Set())

    const count = db.prepare('SELECT COUNT(*) as c FROM symbols').get() as { c: number }
    expect(count.c).toBe(0)
  })
})

describe('removeFile', () => {
  it('removes a file by path', () => {
    getOrCreateFile(db, 'a.ts', 'h', 'typescript', 10)
    removeFile(db, 'a.ts')

    const count = db.prepare("SELECT COUNT(*) as c FROM files WHERE path = 'a.ts'").get() as { c: number }
    expect(count.c).toBe(0)
  })

  it('cleans up associated data', () => {
    const file = getOrCreateFile(db, 'a.ts', 'h', 'typescript', 10)
    insertSymbol(db, file.id, { name: 'foo', kind: 'function', lineStart: 1, lineEnd: 5 })
    insertPkgDep(db, file.id, 'lodash', 'get')

    removeFile(db, 'a.ts')

    const symCount = db.prepare('SELECT COUNT(*) as c FROM symbols').get() as { c: number }
    const pkgCount = db.prepare('SELECT COUNT(*) as c FROM pkg_deps').get() as { c: number }
    expect(symCount.c).toBe(0)
    expect(pkgCount.c).toBe(0)
  })

  it('no-op for non-existent path', () => {
    // Should not throw
    removeFile(db, 'nonexistent.ts')
  })
})

// ── FTS ─────────────────────────────────────────────────────────────

describe('FTS (full-text search)', () => {
  it('inserting a symbol populates symbols_fts', () => {
    const file = getOrCreateFile(db, 'a.ts', 'h', 'typescript', 10)
    insertSymbol(db, file.id, {
      name: 'calculateTotal',
      kind: 'function',
      lineStart: 1,
      lineEnd: 5,
      signature: 'function calculateTotal(items: Item[]): number',
    })

    const results = db.prepare("SELECT * FROM symbols_fts WHERE symbols_fts MATCH 'calculateTotal'").all()
    expect(results.length).toBeGreaterThan(0)
  })

  it('FTS matches partial name via porter stemmer', () => {
    const file = getOrCreateFile(db, 'a.ts', 'h', 'typescript', 10)
    insertSymbol(db, file.id, { name: 'processing', kind: 'function', lineStart: 1, lineEnd: 5 })

    // Porter stemmer should match 'process' → 'processing'
    const results = db.prepare("SELECT * FROM symbols_fts WHERE symbols_fts MATCH 'process'").all()
    expect(results.length).toBeGreaterThan(0)
  })

  it('FTS returns nothing for unrelated query', () => {
    const file = getOrCreateFile(db, 'a.ts', 'h', 'typescript', 10)
    insertSymbol(db, file.id, { name: 'foo', kind: 'function', lineStart: 1, lineEnd: 5 })

    const results = db.prepare("SELECT * FROM symbols_fts WHERE symbols_fts MATCH 'zzzzunrelated'").all()
    expect(results).toHaveLength(0)
  })

  it('deleting symbol removes from FTS (via trigger)', () => {
    const file = getOrCreateFile(db, 'a.ts', 'h', 'typescript', 10)
    const symId = insertSymbol(db, file.id, { name: 'uniqueSymbol', kind: 'function', lineStart: 1, lineEnd: 5 })

    db.prepare('DELETE FROM symbols WHERE id = ?').run(symId)

    const results = db.prepare("SELECT * FROM symbols_fts WHERE symbols_fts MATCH 'uniqueSymbol'").all()
    expect(results).toHaveLength(0)
  })
})
