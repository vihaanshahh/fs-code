/**
 * File watcher — in-process only, no daemon.
 * Adapted from claude-ex/src/watcher/daemon.ts (stripped daemon management).
 */

import * as path from 'path'
import type Database from 'better-sqlite3'
import { reindexFile } from './indexer'
import { isSupportedFile } from './parser'

const IGNORE_PATTERNS = [
  '**/node_modules/**', '**/.git/**', '**/.codex/**', '**/.local/**', '**/dist/**',
  '**/build/**', '**/out/**', '**/.next/**', '**/.nuxt/**',
  '**/__pycache__/**', '**/target/**', '**/vendor/**', '**/coverage/**',
  '**/.cache/**', '**/tmp/**', '**/temp/**',
]

/**
 * Max pending reindex debounces. If a bulk operation (git checkout, npm install)
 * triggers hundreds of file events, we cap the queue and batch-drain them
 * sequentially to avoid flooding the main thread.
 */
const MAX_PENDING_REINDEX = 50

/**
 * Wrapper around chokidar watcher that also clears pending debounce
 * timeouts on close, preventing reindexFile from firing on a closed db.
 */
export interface CodexWatcher {
  close(): void
}

export async function startWatcher(
  rootDir: string,
  db: Database.Database,
  onReindex?: (file: string) => void,
): Promise<CodexWatcher> {
  const chokidar = await import('chokidar')

  const watcher = chokidar.watch(rootDir, {
    ignored: IGNORE_PATTERNS,
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
  })

  const debounceMap = new Map<string, NodeJS.Timeout>()
  let closed = false

  function handleChange(fullPath: string) {
    if (closed) return
    const relPath = path.relative(rootDir, fullPath)
    if (!isSupportedFile(relPath)) return

    const existing = debounceMap.get(relPath)
    if (existing) clearTimeout(existing)

    // If too many files are pending, skip individual debounces —
    // they'll be picked up by the next full index or later watcher events.
    if (debounceMap.size >= MAX_PENDING_REINDEX && !existing) return

    debounceMap.set(relPath, setTimeout(() => {
      debounceMap.delete(relPath)
      if (closed) return // Guard: db may have been closed during the debounce window
      try {
        reindexFile(rootDir, relPath, db)
        onReindex?.(relPath)
      } catch (err) {
        console.error(`[codex] reindex error ${relPath}: ${err}`)
      }
    }, 200))
  }

  function handleDelete(fullPath: string) {
    if (closed) return
    const relPath = path.relative(rootDir, fullPath)
    try {
      reindexFile(rootDir, relPath, db)
    } catch {
      // ignore
    }
  }

  watcher.on('change', handleChange)
  watcher.on('add', handleChange)
  watcher.on('unlink', handleDelete)

  return {
    close() {
      closed = true
      // Cancel all pending debounced reindexes to prevent use-after-close on db
      for (const timeout of debounceMap.values()) {
        clearTimeout(timeout)
      }
      debounceMap.clear()
      watcher.close()
    },
  }
}
