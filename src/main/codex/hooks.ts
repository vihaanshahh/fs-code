/**
 * Programmatic hooks — replaces .claude/settings.json hooks entirely.
 * Injected into the Claude SDK query() options so context flows automatically.
 *
 * - SessionStart: injects project brief (architecture overview, key symbols, file map)
 * - PreToolUse (Write/Edit/MultiEdit/Read): injects file dependency context
 * - PostToolUse (Write/Edit/MultiEdit): triggers incremental reindex
 */

import * as path from 'path'
import type Database from 'better-sqlite3'
import type { HookCallbackMatcher, HookInput, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk'
import { brief, preEditContext } from './query'
import { reindexFile } from './indexer'

/**
 * Create hook callbacks for automatic code intelligence.
 * Returns a Record<HookEvent, HookCallbackMatcher[]> to pass to query() options.
 */
export function createCodexHooks(
  db: Database.Database,
  rootDir: string,
): Partial<Record<string, HookCallbackMatcher[]>> {
  return {
    // On session start, inject a full project brief as context
    SessionStart: [{
      hooks: [async (_input: HookInput): Promise<HookJSONOutput> => {
        try {
          const projectBrief = brief(db)
          return {
            continue: true,
            additionalContext: projectBrief,
          } as any
        } catch (err) {
          console.error('[codex] brief hook error:', err)
          return { continue: true } as any
        }
      }],
    }],

    // Before file edits/reads, inject dependency and impact context
    PreToolUse: [{
      matcher: 'Write|Edit|MultiEdit|Read',
      hooks: [async (input: HookInput): Promise<HookJSONOutput> => {
        try {
          const toolInput = (input as any).tool_input as any
          const filePath = toolInput?.file_path || toolInput?.path
          if (!filePath) return { continue: true } as any

          const rel = path.isAbsolute(filePath) ? path.relative(rootDir, filePath) : filePath
          const context = preEditContext(db, rel)

          return {
            continue: true,
            additionalContext: context,
          } as any
        } catch (err) {
          console.error('[codex] pre-edit hook error:', err)
          return { continue: true } as any
        }
      }],
    }],

    // After file edits, reindex the modified file
    PostToolUse: [{
      matcher: 'Write|Edit|MultiEdit',
      hooks: [async (input: HookInput): Promise<HookJSONOutput> => {
        try {
          const toolInput = (input as any).tool_input as any
          const filePath = toolInput?.file_path || toolInput?.path
          if (filePath) {
            const rel = path.isAbsolute(filePath) ? path.relative(rootDir, filePath) : filePath
            reindexFile(rootDir, rel, db)
          }
        } catch (err) {
          console.error('[codex] post-edit hook error:', err)
        }
        return { continue: true } as any
      }],
    }],
  }
}
