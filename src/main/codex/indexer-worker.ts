/**
 * Worker thread for CPU-heavy project indexing.
 *
 * Runs in a separate thread via `worker_threads` so the Electron main
 * process never blocks. Opens its own SQLite connection (WAL mode
 * allows concurrent readers on the main thread).
 *
 * Protocol:
 *   workerData = { cwd: string, dbPath: string }
 *   posts back  = IndexStats | { error: string }
 */

import { workerData, parentPort } from 'worker_threads'
import { indexProjectSync } from './indexer'
import { openDatabase } from './db'

const { cwd, dbPath } = workerData as { cwd: string; dbPath: string }

let db: ReturnType<typeof openDatabase> | null = null
try {
  db = openDatabase(cwd, dbPath)
  const stats = indexProjectSync(cwd, db, {
    onProgress: (p) => parentPort?.postMessage({ type: 'progress', ...p }),
  })
  parentPort?.postMessage({ type: 'complete', ...stats })
} catch (err: any) {
  parentPort?.postMessage({ error: err?.message || String(err) })
} finally {
  // Always close DB — even if indexProjectSync throws, we must release the file handle
  try { db?.close() } catch {}
}
