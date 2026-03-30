/**
 * Indexer — adapted from claude-ex/src/indexer/index.ts
 *
 * Two modes:
 *   1. `indexProjectSync()` — fast synchronous, runs in worker thread or tests
 *   2. `runIndexInWorker()` — spawns a worker thread, zero main-thread blocking
 *
 * The CodexManager always uses (2) so the Electron UI never freezes.
 */

import * as fs from 'fs'
import * as path from 'path'
import { Worker } from 'worker_threads'
import type Database from 'better-sqlite3'
import {
  getOrCreateFile, clearFileData,
  insertSymbol, insertEdge, insertFileDep, insertPkgDep, insertTypeRelation,
  removeStaleFiles, removeFile, getIndexDir, isFileUnchangedByMtime, getOrPrepare,
} from './db'
import { collectFiles } from './collector'
import { parseFile, hashFile, getLanguage } from './parser'

export interface IndexStats {
  totalFiles: number
  indexedFiles: number
  skippedFiles: number
  symbols: number
  edges: number
  timeMs: number
}

export interface IndexProgress {
  filesProcessed: number
  totalFiles: number
  symbols: number
}

/** Cache import resolutions to avoid repeated fs.existsSync calls (up to 10 per import).
 *  Capped to prevent unbounded growth from watcher-triggered reindexFile calls. */
const MAX_IMPORT_CACHE = 10_000
const importCache = new Map<string, string | null>()

function resolveImportPath(rootDir: string, fromFile: string, importSource: string): string | null {
  if (!importSource.startsWith('.') && !importSource.startsWith('/')) return null

  const fromDir = path.dirname(path.join(rootDir, fromFile))
  const resolved = path.resolve(fromDir, importSource)
  const rel = path.relative(rootDir, resolved)

  // Check cache first — same rel path always resolves the same way
  const cached = importCache.get(rel)
  if (cached !== undefined) return cached

  // Evict entire cache if it grows too large (prevents OOM from long-running watchers)
  if (importCache.size >= MAX_IMPORT_CACHE) importCache.clear()

  const extensions = ['.ts', '.tsx', '.js', '.jsx', '.py', '.rs', '.go', '']
  const indexFiles = ['/index.ts', '/index.tsx', '/index.js', '/index.jsx']

  for (const ext of extensions) {
    const candidate = rel + ext
    if (fs.existsSync(path.join(rootDir, candidate))) {
      importCache.set(rel, candidate)
      return candidate
    }
  }

  for (const idx of indexFiles) {
    const candidate = rel + idx
    if (fs.existsSync(path.join(rootDir, candidate))) {
      importCache.set(rel, candidate)
      return candidate
    }
  }

  importCache.set(rel, null)
  return null
}

function isPackageImport(source: string): boolean {
  return !source.startsWith('.') && !source.startsWith('/')
}

/** Count newlines without allocating an array (avoids split('\n').length) */
function countLines(content: string): number {
  let count = 1
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10) count++
  }
  return count
}

const MAX_FILE_SIZE = 512 * 1024 // 512KB

/**
 * Synchronous full project index.
 *
 * Called directly in the worker thread (or in tests). Do NOT call this
 * from the Electron main process — use `runIndexInWorker()` instead.
 */
export function indexProjectSync(rootDir: string, db: Database.Database, options?: { verbose?: boolean; onProgress?: (p: IndexProgress) => void }): IndexStats {
  const start = performance.now()
  const files = collectFiles(rootDir)
  const verbose = options?.verbose ?? false

  // Clear import resolution cache for this run
  importCache.clear()

  let indexedFiles = 0
  let skippedFiles = 0
  let totalSymbols = 0
  let totalEdges = 0

  const fileSymbolMap = new Map<string, Map<string, number>>()
  const fileImportMap = new Map<string, { resolved: string; names: string[] }[]>()
  const validPaths = new Set(files)

  // Prepare statements used in the hot loop ONCE, not per-iteration
  const selectSymbolsStmt = db.prepare(
    'SELECT id, name, qualified_name, exported FROM symbols WHERE file_id = ?',
  )
  const selectFileIdStmt = db.prepare('SELECT id FROM files WHERE path = ?')

  const transaction = db.transaction(() => {
    for (const relPath of files) {
      const fullPath = path.join(rootDir, relPath)

      // Stat once — used for both size guard and mtime fast-path
      let stat: fs.Stats | undefined
      try {
        stat = fs.statSync(fullPath)
      } catch {
        skippedFiles++
        continue
      }
      if (stat.size > MAX_FILE_SIZE) {
        skippedFiles++
        continue
      }

      // MTIME FAST PATH: if mtime matches DB, skip read+hash+parse entirely.
      // On a warm re-index this avoids reading thousands of unchanged files.
      const mtimeCheck = isFileUnchangedByMtime(db, relPath, stat.mtimeMs)
      if (mtimeCheck.unchanged) {
        skippedFiles++
        // Still need symbol map for cross-file edge resolution
        const existingSymbols = selectSymbolsStmt.all(mtimeCheck.fileId!) as { id: number; name: string; qualified_name: string | null; exported: number }[]
        const symbolMap = new Map<string, number>()
        for (const s of existingSymbols) {
          if (s.exported) {
            symbolMap.set(s.name, s.id)
            if (s.qualified_name) symbolMap.set(s.qualified_name, s.id)
          }
        }
        fileSymbolMap.set(relPath, symbolMap)
        continue
      }

      let content: string
      try {
        content = fs.readFileSync(fullPath, 'utf-8')
      } catch {
        skippedFiles++
        continue
      }

      const hash = hashFile(content)
      const language = getLanguage(relPath)
      const lineCount = countLines(content)
      const mtime = stat.mtimeMs
      const fileRecord = getOrCreateFile(db, relPath, hash, language, lineCount, mtime)

      if (!fileRecord.changed) {
        skippedFiles++
        const existingSymbols = selectSymbolsStmt.all(fileRecord.id) as { id: number; name: string; qualified_name: string | null; exported: number }[]
        const symbolMap = new Map<string, number>()
        for (const s of existingSymbols) {
          if (s.exported) {
            symbolMap.set(s.name, s.id)
            if (s.qualified_name) symbolMap.set(s.qualified_name, s.id)
          }
        }
        fileSymbolMap.set(relPath, symbolMap)
        continue
      }

      clearFileData(db, fileRecord.id)
      const parsed = parseFile(relPath, content)

      const symbolMap = new Map<string, number>()

      for (const sym of parsed.symbols) {
        const symId = insertSymbol(db, fileRecord.id, {
          name: sym.name,
          qualifiedName: sym.qualifiedName,
          kind: sym.kind,
          lineStart: sym.lineStart,
          lineEnd: sym.lineEnd,
          signature: sym.signature,
          docstring: sym.docstring,
          content: sym.content,
          exported: sym.exported,
          parameters: sym.parameters ? JSON.stringify(sym.parameters) : undefined,
        })
        symbolMap.set(sym.name, symId)
        if (sym.qualifiedName) symbolMap.set(sym.qualifiedName, symId)
        totalSymbols++

        if (sym.extends) {
          for (const parent of sym.extends) {
            insertTypeRelation(db, symId, parent, 'extends')
          }
        }
        if (sym.implements) {
          for (const iface of sym.implements) {
            insertTypeRelation(db, symId, iface, 'implements')
          }
        }
      }

      fileSymbolMap.set(relPath, symbolMap)

      // Re-export pseudo-symbols
      for (const reExport of parsed.reExports) {
        for (const name of reExport.names) {
          if (!symbolMap.has(name)) {
            const symId = insertSymbol(db, fileRecord.id, {
              name,
              kind: 'reexport',
              lineStart: 0,
              lineEnd: 0,
              signature: `export { ${name} } from '${reExport.source}'`,
              exported: true,
            })
            symbolMap.set(name, symId)
            totalSymbols++
          }
        }
      }

      // Resolve imports
      const resolvedImports: { resolved: string; names: string[] }[] = []
      for (const imp of parsed.imports) {
        if (isPackageImport(imp.source)) {
          const names = imp.names.length > 0 ? imp.names.join(',') : imp.isDefault ? 'default' : '*'
          insertPkgDep(db, fileRecord.id, imp.source, names)
          continue
        }

        const resolved = resolveImportPath(rootDir, relPath, imp.source)
        if (resolved) {
          const toFile = selectFileIdStmt.get(resolved) as { id: number } | undefined
          if (toFile) {
            const importName = imp.names.length > 0 ? imp.names.join(',') : '*'
            insertFileDep(db, fileRecord.id, toFile.id, 'import', importName)
          }
          resolvedImports.push({ resolved, names: imp.names })
        }
      }
      fileImportMap.set(relPath, resolvedImports)

      // Intra-file call edges
      for (const call of parsed.calls) {
        const callerId = symbolMap.get(call.callerSymbol)
        const calledId = symbolMap.get(call.calledName)
        if (callerId && calledId && callerId !== calledId) {
          insertEdge(db, callerId, calledId, 'calls', call.line)
          totalEdges++
        }
      }

      indexedFiles++
      if (verbose && indexedFiles % 100 === 0) {
        console.log(`[codex] Indexed ${indexedFiles} files...`)
      }
      if (options?.onProgress && (indexedFiles + skippedFiles) % 50 === 0) {
        options.onProgress({ filesProcessed: indexedFiles + skippedFiles, totalFiles: files.length, symbols: totalSymbols })
      }
    }

    // Remove stale files
    removeStaleFiles(db, validPaths)

    // Cross-file edge resolution
    for (const [filePath, resolvedImports] of fileImportMap) {
      const importingSymbols = fileSymbolMap.get(filePath)
      if (!importingSymbols) continue

      for (const imp of resolvedImports) {
        const exportedSymbols = fileSymbolMap.get(imp.resolved)
        if (!exportedSymbols) continue

        for (const importedName of imp.names) {
          const targetId = exportedSymbols.get(importedName)
          if (targetId) {
            for (const [, srcId] of importingSymbols) {
              if (srcId !== targetId) {
                insertEdge(db, srcId, targetId, 'references')
                totalEdges++
              }
            }
          }
        }
      }
    }
  })

  transaction()

  // Compute PageRank
  computePageRank(db)

  return {
    totalFiles: files.length,
    indexedFiles,
    skippedFiles,
    symbols: totalSymbols,
    edges: totalEdges,
    timeMs: performance.now() - start,
  }
}

// Keep backward-compat alias for tests
export { indexProjectSync as indexProject }

/**
 * Global concurrency limiter for indexing workers.
 * Prevents N agents from each spawning a worker simultaneously,
 * which would thrash CPU and spike memory.
 */
const MAX_CONCURRENT_WORKERS = 2
let activeWorkers = 0
const workerQueue: Array<{ run: () => void }> = []

function acquireWorkerSlot(): Promise<void> {
  if (activeWorkers < MAX_CONCURRENT_WORKERS) {
    activeWorkers++
    return Promise.resolve()
  }
  return new Promise(resolve => {
    workerQueue.push({ run: () => { activeWorkers++; resolve() } })
  })
}

function releaseWorkerSlot(): void {
  activeWorkers--
  const next = workerQueue.shift()
  if (next) next.run()
}

/**
 * Run project indexing in a worker thread.
 *
 * This is what the CodexManager should call. The heavy work
 * (file I/O, tree-sitter parsing, SQLite writes, PageRank)
 * all happens on a separate CPU core. The main Electron thread
 * stays completely free.
 *
 * Workers are limited to MAX_CONCURRENT_WORKERS (2) to prevent
 * CPU thrash and memory spikes when many agents start at once.
 *
 * The worker opens its own DB connection (WAL mode supports concurrent
 * readers), so MCP queries keep working during indexing.
 *
 * @param dbPathOverride — pass a direct DB path (for tests).
 *   If omitted, uses the standard app-data location.
 */
export async function runIndexInWorker(cwd: string, dbPathOverride?: string, onProgress?: (p: IndexProgress) => void): Promise<IndexStats> {
  await acquireWorkerSlot()
  try {
    return await new Promise<IndexStats>((resolve, reject) => {
      const dbPath = dbPathOverride || path.join(getIndexDir(cwd), 'index.db')

      // Resolve the worker script path.
      // In production: this file is in out/main/chunks/, worker is in out/main/.
      // In development: both are in the same source directory.
      // We try the parent directory first (production), then __dirname (dev/test).
      let workerPath = path.join(__dirname, '..', 'indexer-worker.js')
      if (!fs.existsSync(workerPath)) {
        workerPath = path.join(__dirname, 'indexer-worker.js')
      }

      const worker = new Worker(workerPath, {
        workerData: { cwd, dbPath },
        resourceLimits: {
          maxOldGenerationSizeMb: 256,  // Cap worker heap to 256MB
        },
      })

      worker.on('message', (msg) => {
        if (msg && typeof msg === 'object') {
          if ('error' in msg) {
            reject(new Error(msg.error))
          } else if (msg.type === 'progress' && onProgress) {
            onProgress(msg as IndexProgress)
          } else if (msg.type === 'complete' || !('type' in msg)) {
            resolve(msg as IndexStats)
          }
        }
      })

      worker.on('error', (err) => {
        reject(err)
      })

      worker.on('exit', (code) => {
        if (code !== 0) {
          reject(new Error(`Indexer worker exited with code ${code}`))
        }
      })
    })
  } finally {
    releaseWorkerSlot()
  }
}

/**
 * Incremental single-file reindex.
 * Fast enough to run on the main thread (single file only).
 */
export function reindexFile(rootDir: string, relPath: string, db: Database.Database): void {
  const fullPath = path.join(rootDir, relPath)

  let stat: fs.Stats
  try {
    stat = fs.statSync(fullPath)
  } catch {
    removeFile(db, relPath)
    return
  }

  if (stat.size > MAX_FILE_SIZE) return

  let content: string
  try {
    content = fs.readFileSync(fullPath, 'utf-8')
  } catch {
    return
  }

  const hash = hashFile(content)
  const language = getLanguage(relPath)
  const lineCount = countLines(content)
  const fileRecord = getOrCreateFile(db, relPath, hash, language, lineCount, stat.mtimeMs)

  if (!fileRecord.changed) return

  clearFileData(db, fileRecord.id)
  const parsed = parseFile(relPath, content)

  const symbolMap = new Map<string, number>()
  for (const sym of parsed.symbols) {
    const symId = insertSymbol(db, fileRecord.id, {
      name: sym.name,
      qualifiedName: sym.qualifiedName,
      kind: sym.kind,
      lineStart: sym.lineStart,
      lineEnd: sym.lineEnd,
      signature: sym.signature,
      docstring: sym.docstring,
      content: sym.content,
      exported: sym.exported,
      parameters: sym.parameters ? JSON.stringify(sym.parameters) : undefined,
    })
    symbolMap.set(sym.name, symId)
    if (sym.qualifiedName) symbolMap.set(sym.qualifiedName, symId)

    if (sym.extends) {
      for (const parent of sym.extends) {
        insertTypeRelation(db, symId, parent, 'extends')
      }
    }
    if (sym.implements) {
      for (const iface of sym.implements) {
        insertTypeRelation(db, symId, iface, 'implements')
      }
    }
  }

  // Re-export pseudo-symbols
  for (const reExport of parsed.reExports) {
    for (const name of reExport.names) {
      if (!symbolMap.has(name)) {
        const symId = insertSymbol(db, fileRecord.id, {
          name,
          kind: 'reexport',
          lineStart: 0,
          lineEnd: 0,
          signature: `export { ${name} } from '${reExport.source}'`,
          exported: true,
        })
        symbolMap.set(name, symId)
      }
    }
  }

  // Resolve imports
  for (const imp of parsed.imports) {
    if (isPackageImport(imp.source)) {
      const names = imp.names.length > 0 ? imp.names.join(',') : imp.isDefault ? 'default' : '*'
      insertPkgDep(db, fileRecord.id, imp.source, names)
      continue
    }

    const resolved = resolveImportPath(rootDir, relPath, imp.source)
    if (resolved) {
      const toFile = getOrPrepare(db, 'SELECT id FROM files WHERE path = ?').get(resolved) as { id: number } | undefined
      if (toFile) {
        insertFileDep(db, fileRecord.id, toFile.id, 'import', imp.names.join(',') || '*')
      }
    }
  }

  // Intra-file call edges
  for (const call of parsed.calls) {
    const callerId = symbolMap.get(call.callerSymbol)
    const calledId = symbolMap.get(call.calledName)
    if (callerId && calledId && callerId !== calledId) {
      insertEdge(db, callerId, calledId, 'calls', call.line)
    }
  }
}

function computePageRank(db: Database.Database, iterations: number = 20, damping: number = 0.85): void {
  const symbols = db.prepare('SELECT id FROM symbols').all() as { id: number }[]
  if (symbols.length === 0) return

  const n = symbols.length
  const idToIdx = new Map<number, number>()
  const ids: number[] = []

  for (let i = 0; i < symbols.length; i++) {
    idToIdx.set(symbols[i].id, i)
    ids.push(symbols[i].id)
  }

  const edges = db.prepare('SELECT from_id, to_id FROM edges').all() as { from_id: number; to_id: number }[]

  const outgoing: number[][] = new Array(n).fill(null).map(() => [])
  const outDegree = new Array(n).fill(0)
  const inDegree = new Array(n).fill(0)

  for (const edge of edges) {
    const from = idToIdx.get(edge.from_id)
    const to = idToIdx.get(edge.to_id)
    if (from !== undefined && to !== undefined) {
      outgoing[from].push(to)
      outDegree[from]++
      inDegree[to]++
    }
  }

  let rank = new Float64Array(n).fill(1 / n)
  let newRank = new Float64Array(n)

  for (let iter = 0; iter < iterations; iter++) {
    // Accumulate dangling mass in O(n) — not O(n²) per dangling node
    let danglingMass = 0
    for (let i = 0; i < n; i++) {
      if (outDegree[i] === 0) danglingMass += rank[i]
    }
    const danglingShare = damping * danglingMass / n

    newRank.fill((1 - damping) / n + danglingShare)
    for (let i = 0; i < n; i++) {
      if (outDegree[i] > 0) {
        const share = rank[i] / outDegree[i]
        for (const j of outgoing[i]) {
          newRank[j] += damping * share
        }
      }
    }
    ;[rank, newRank] = [newRank, rank]
  }

  db.prepare('DELETE FROM rankings').run()
  const insertRank = db.prepare(
    'INSERT INTO rankings (symbol_id, pagerank, in_degree, out_degree) VALUES (?, ?, ?, ?)',
  )
  const writeRankings = db.transaction(() => {
    for (let i = 0; i < n; i++) {
      insertRank.run(ids[i], rank[i], inDegree[i], outDegree[i])
    }
  })
  writeRankings()
}
