/**
 * In-process MCP server — uses the Claude Agent SDK's createSdkMcpServer() + tool()
 * to expose all 14 codex tools directly inside FluidState's process.
 * Zero subprocesses. Zero repo files. Claude gets the tools automatically.
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import type Database from 'better-sqlite3'
import { z } from 'zod'
import {
  search, getCallers, getContext, getImpact,
  getDeps, getRank, getModules, getStats, findFiles, getFileMap,
  getFileSymbols, findByKind, getTypeHierarchy, findDeadExports, getPkgUsages,
} from './query'
import { reindexFile } from './indexer'

/**
 * Create an in-process MCP server with all 14 codex tools.
 * Returns a config that can be passed directly to query() options.mcpServers.
 */
export function createCodexMcpServer(db: Database.Database, rootDir: string) {
  return createSdkMcpServer({
    name: 'codex',
    version: '1.0.0',
    tools: [
      tool(
        'search_code',
        'Search codebase for symbols by name, description, or content. Results ranked by structural importance (PageRank). Faster and more precise than grep for finding the right code.',
        { query: z.string().describe('Search query (natural language or symbol name)'), limit: z.number().optional().describe('Max results (default 15)') },
        async (args) => ({
          content: [{ type: 'text' as const, text: JSON.stringify(search(db, args.query, args.limit), null, 2) }],
        }),
      ),

      tool(
        'get_symbol',
        'Get complete context for a symbol: its code, what it depends on, what depends on it, co-located symbols. Use before modifying any symbol.',
        { name: z.string().describe('Symbol name or qualified name (e.g., processPayment or PaymentService.processPayment)') },
        async (args) => {
          const result = getContext(db, args.name)
          if (!result) {
            return { content: [{ type: 'text' as const, text: `Symbol '${args.name}' not found in index.` }] }
          }
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] }
        },
      ),

      tool(
        'get_callers',
        'Find all callers of a function or method. Use before renaming, changing signatures, or removing functions.',
        { name: z.string().describe('Function or method name') },
        async (args) => ({
          content: [{ type: 'text' as const, text: JSON.stringify(getCallers(db, args.name), null, 2) }],
        }),
      ),

      tool(
        'get_dependents',
        'Find all files transitively affected if a file changes. Use before refactors that change exports or file structure.',
        { file: z.string().describe('File path relative to project root'), maxDepth: z.number().optional().describe('Max traversal depth (default 10)') },
        async (args) => ({
          content: [{ type: 'text' as const, text: JSON.stringify(getImpact(db, args.file, args.maxDepth), null, 2) }],
        }),
      ),

      tool(
        'get_dependencies',
        'Find what a symbol depends on (imports, inherited classes, referenced types).',
        { name: z.string().describe('Symbol name') },
        async (args) => ({
          content: [{ type: 'text' as const, text: JSON.stringify(getDeps(db, args.name), null, 2) }],
        }),
      ),

      tool(
        'get_architecture',
        'Get project architecture overview: top symbols by importance, module dependency map, language breakdown.',
        { top: z.number().optional().describe('Number of top symbols to include (default 20)') },
        async (args) => ({
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              stats: getStats(db),
              topSymbols: getRank(db, args.top || 20),
              modules: getModules(db),
            }, null, 2),
          }],
        }),
      ),

      tool(
        'get_file_map',
        'Get a map of every file in the project with its exported symbols. Use to understand where things live without searching.',
        {},
        async () => ({
          content: [{ type: 'text' as const, text: JSON.stringify(getFileMap(db), null, 2) }],
        }),
      ),

      tool(
        'find_files',
        'Find files by path pattern using glob syntax (e.g. "**/*.test.ts", "src/components/*"). Faster than shell find/ls.',
        { pattern: z.string().describe('Glob pattern to match file paths'), limit: z.number().optional().describe('Max results (default 50)') },
        async (args) => ({
          content: [{ type: 'text' as const, text: JSON.stringify(findFiles(db, args.pattern, args.limit), null, 2) }],
        }),
      ),

      tool(
        'get_file_symbols',
        'Get all symbols (functions, classes, variables, etc.) in a specific file with their signatures and parameters.',
        { file: z.string().describe('File path relative to project root') },
        async (args) => ({
          content: [{ type: 'text' as const, text: JSON.stringify(getFileSymbols(db, args.file), null, 2) }],
        }),
      ),

      tool(
        'find_by_kind',
        'Find all symbols of a specific kind (class, function, interface, type, enum, method, variable). Ranked by structural importance.',
        { kind: z.string().describe('Symbol kind: class, function, interface, type, enum, method, variable, reexport'), limit: z.number().optional().describe('Max results (default 50)') },
        async (args) => ({
          content: [{ type: 'text' as const, text: JSON.stringify(findByKind(db, args.kind, args.limit), null, 2) }],
        }),
      ),

      tool(
        'get_type_hierarchy',
        'Find all classes that extend or implement a given class/interface. Use before changing a base class or interface.',
        { name: z.string().describe('Class or interface name to find subclasses/implementors of') },
        async (args) => ({
          content: [{ type: 'text' as const, text: JSON.stringify(getTypeHierarchy(db, args.name), null, 2) }],
        }),
      ),

      tool(
        'find_dead_exports',
        'Find exported symbols that nothing imports or references. Useful for dead code detection and cleanup.',
        { limit: z.number().optional().describe('Max results (default 50)') },
        async (args) => ({
          content: [{ type: 'text' as const, text: JSON.stringify(findDeadExports(db, args.limit), null, 2) }],
        }),
      ),

      tool(
        'get_pkg_usages',
        'Find all files that import from a given npm/pip/cargo package. Use before swapping a library to find every usage.',
        { package: z.string().describe('Package name (e.g., "react", "lodash", "express")') },
        async (args) => ({
          content: [{ type: 'text' as const, text: JSON.stringify(getPkgUsages(db, args.package), null, 2) }],
        }),
      ),

      tool(
        'reindex_file',
        'Re-index a single file immediately after editing it.',
        { file: z.string().describe('File path relative to project root') },
        async (args) => {
          const start = performance.now()
          try {
            reindexFile(rootDir, args.file, db)
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ success: true, timeMs: +(performance.now() - start).toFixed(1) }) }],
            }
          } catch (err: any) {
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: err?.message || String(err) }) }],
            }
          }
        },
      ),
    ],
  })
}
