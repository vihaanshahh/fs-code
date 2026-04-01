/**
 * CodexManager — lifecycle orchestrator for per-agent code intelligence.
 *
 * One instance per agent cwd. Handles:
 * 1. Opening/creating the index DB (in FluidState app data)
 * 2. Background initial indexing (in a worker thread — zero main-thread blocking)
 * 3. In-process MCP server with 14 tools
 * 4. Hook callbacks for automatic context injection
 *
 * Live reindex is handled by claude-ex post-edit hooks (no directory watcher needed).
 * Managers are ref-counted by cwd so multiple agents sharing a project
 * reuse the same index.
 */

import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import type { McpSdkServerConfigWithInstance, HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk'
import type { CodexStatus } from '../../shared/types'
import { openDatabase, getIndexDir } from './db'
import { runIndexInWorker } from './indexer'
import { createCodexMcpServer } from './mcp-server'
import { createCodexHooks } from './hooks'


export class CodexManager {
  private db: Database.Database | null = null
  private mcpServer: McpSdkServerConfigWithInstance | null = null
  private hooks: Partial<Record<string, HookCallbackMatcher[]>> | null = null
  private indexReady = false
  private indexPromise: Promise<void> | null = null
  private disposed = false
  private statusCallback: ((status: CodexStatus) => void) | null = null
  private initError: string | null = null

  constructor(private readonly cwd: string) {}

  /** Register a callback for status changes (loading, indexing, ready, error) */
  onStatus(cb: (status: CodexStatus) => void): void {
    this.statusCallback = cb
    // Emit current state immediately if already known
    if (this.indexReady) {
      cb({ state: 'ready' })
    } else if (this.initError) {
      cb({ state: 'error', error: this.initError })
    }
  }

  private emitStatus(status: CodexStatus): void {
    if (!this.disposed) this.statusCallback?.(status)
  }

  /**
   * Initialize the code intelligence engine.
   * Opens DB, kicks off background index in a worker thread, starts watcher,
   * creates MCP server + hooks.
   *
   * Non-blocking — the initial index runs on a separate CPU core.
   */
  async initialize(): Promise<void> {
    try {
      this.emitStatus({ state: 'loading' })

      // 1. Open/create DB in app data (main-thread connection for queries)
      this.db = openDatabase(this.cwd)
      console.log(`[codex] opened database for ${this.cwd}`)

      // 2. Create MCP server and hooks immediately (they'll query whatever's in the DB)
      this.mcpServer = createCodexMcpServer(this.db, this.cwd)
      this.hooks = createCodexHooks(this.db, this.cwd)

      // 3. Background initial index in a WORKER THREAD (zero main-thread blocking).
      //    The worker opens its own DB connection (WAL mode allows concurrent access).
      //    Live reindex is handled by claude-ex post-edit hooks — no directory watcher needed.
      this.indexPromise = this.runInitialIndex().catch((err) => {
        console.error('[codex] background index failed:', err)
      })
    } catch (err) {
      console.error('[codex] initialization failed:', err)
      this.initError = err instanceof Error ? err.message : String(err)
      this.emitStatus({ state: 'error', error: this.initError })
      // Non-fatal — agent still works, just without code intelligence
    }
  }

  private async runInitialIndex(): Promise<void> {
    if (!this.db) return
    try {
      // If the DB already exists and has content, it's already indexed.
      // Skip the worker scan entirely — the file watcher handles incremental updates.
      const dbPath = join(getIndexDir(this.cwd), 'index.db')
      try {
        const { size } = await stat(dbPath)
        if (size > 0) {
          console.log(`[codex] index exists — ready immediately for ${this.cwd}`)
          this.indexReady = true
          this.emitStatus({ state: 'ready' })
          return
        }
      } catch { /* DB doesn't exist yet — run full index below */ }

      // First run for this project: build the index from scratch.
      this.emitStatus({ state: 'indexing', filesProcessed: 0, totalFiles: 0, symbols: 0 })
      const start = performance.now()
      const stats = await runIndexInWorker(this.cwd, undefined, (p) => {
        if (!this.disposed) {
          this.emitStatus({ state: 'indexing', filesProcessed: p.filesProcessed, totalFiles: p.totalFiles, symbols: p.symbols })
        }
      })
      if (this.disposed) return
      const elapsed = (performance.now() - start).toFixed(0)
      console.log(`[codex] indexed ${stats.totalFiles} files in ${elapsed}ms — ${stats.symbols} symbols, ${stats.edges} edges`)
      this.indexReady = true
      this.emitStatus({ state: 'ready', filesProcessed: stats.totalFiles, totalFiles: stats.totalFiles, symbols: stats.symbols })
    } catch (err) {
      if (this.disposed) return
      console.error('[codex] initial index failed:', err)
      this.emitStatus({ state: 'error', error: String(err) })
    }
  }

  /** Whether the initial index has completed */
  get isReady(): boolean {
    return this.indexReady
  }

  get isAvailable(): boolean {
    return !this.initError && !!this.db && !!this.mcpServer
  }

  /** Wait for initial index to complete (for tests/debug) */
  async waitForIndex(): Promise<void> {
    if (this.indexPromise) await this.indexPromise
  }

  /**
   * Get MCP server config to pass to query() options.mcpServers.
   * Returns { codex: McpSdkServerConfigWithInstance } or empty object.
   */
  getMcpServers(): Record<string, any> {
    if (!this.mcpServer) return {}
    return { codex: this.mcpServer }
  }

  /**
   * Get hooks to pass to query() options.hooks.
   * Returns hook matchers for SessionStart/PreToolUse/PostToolUse.
   */
  getHooks(): Partial<Record<string, HookCallbackMatcher[]>> {
    return this.hooks || {}
  }

  /**
   * Clean up all resources — DB, watcher, etc.
   */
  dispose(): void {
    this.disposed = true
    try {
      if (this.db) {
        this.db.close()
        this.db = null
      }
      this.mcpServer = null
      this.hooks = null
      console.log(`[codex] disposed for ${this.cwd}`)
    } catch (err) {
      console.error('[codex] dispose error:', err)
    }
  }
}

// --- Ref-counted manager cache (share index across agents with same cwd) ---

const managerCache = new Map<string, { manager: CodexManager; refCount: number }>()

/**
 * Get or create a CodexManager for a project directory.
 * Ref-counted: multiple agents with the same cwd share the same manager.
 */
export async function acquireManager(cwd: string): Promise<CodexManager> {
  const existing = managerCache.get(cwd)
  if (existing) {
    existing.refCount++
    console.log(`[codex] reusing manager for ${cwd} (refs: ${existing.refCount})`)
    return existing.manager
  }

  const manager = new CodexManager(cwd)
  await manager.initialize()
  managerCache.set(cwd, { manager, refCount: 1 })
  return manager
}

/**
 * Release a reference to a CodexManager.
 * Disposes when the last reference is released.
 */
export function releaseManager(cwd: string): void {
  const entry = managerCache.get(cwd)
  if (!entry) return

  entry.refCount--
  if (entry.refCount <= 0) {
    entry.manager.dispose()
    managerCache.delete(cwd)
  }
}
