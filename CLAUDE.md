<!-- claude-ex:start -->
# Project: fs-code

## Architecture
- **Languages**: javascript (58 files), typescript (57 files), json (55 files), c (33 files), tsx (29 files), cpp (22 files), html (1 files), css (1 files), bash (1 files)
- **Size**: 537 files, 27857 symbols, 26120 relationships

## Key Symbols (by structural importance)
1. `useTheme` [function] in src/renderer/ThemeContext.tsx
2. `getOrPrepare` [function] in src/main/codex/db.ts
3. `JsonlProvider` [class] in src/main/providers/jsonl-provider.ts
4. `ThemeColors` [type] in src/renderer/theme.ts
5. `ModelInfo` [interface] in src/main/providers/provider.ts
6. `getLanguage` [function] in src/main/codex/parser.ts
7. `reindexFile` [function] in src/main/codex/indexer.ts
8. `getClaudePath` [function] in src/main/auth.ts
9. `ProviderHandle` [interface] in src/main/providers/provider.ts
10. `SendPromptOptions` [interface] in src/main/providers/provider.ts
11. `ProviderDriver` [interface] in src/main/providers/provider.ts
12. `PermissionHandler` [type] in src/main/providers/provider.ts
13. `ThemeMode` [type] in src/renderer/theme.ts
14. `buildPhaseColorMap` [function] in src/renderer/theme.ts
15. `buildTheme` [function] in src/renderer/theme.ts

## Module Map
dist/ (427 files, 25648 symbols) → imports from: (none — leaf dependency)
out/ (14 files, 1677 symbols) → imports from: (none — leaf dependency)
src/ (86 files, 532 symbols) → imports from: (none — leaf dependency)
./ (8 files, 0 symbols) → imports from: (none — leaf dependency)
.claude/ (1 files, 0 symbols) → imports from: (none — leaf dependency)
node_modules/ (1 files, 0 symbols) → imports from: (none — leaf dependency)

## File Map (file → key exports)

- `.claude/settings.local.json`
- `.mcp.json`
- `electron.vite.config.ts`
- `package-lock.json`
- `package.json`
- `src/main/agent-env.test.ts`
- `src/main/agent-env.ts` — buildCleanEnv, getCliAccessFlag, getCliAccessError
- `src/main/agent.ts` — setMainWindow, getResourceStats, startMemoryMonitor, createAgent, closeAgent, listAgents, sendPrompt, stopSession +12 more
- `src/main/auth.ts` — getClaudePath, getAuthStatus, ensureClaudeBin, login, logout, fetchUsage
- `src/main/cli-install.ts` — isCLIInstalled, installCLI, uninstallCLI, autoInstallCLI
- `src/main/codex/codex-await.test.ts`
- `src/main/codex/codex.test.ts`
- `src/main/codex/collector.test.ts`
- `src/main/codex/collector.ts` — collectFiles
- `src/main/codex/db.test.ts`
- `src/main/codex/db.ts` — getOrPrepare, clearFileData, openDatabase, getIndexDir, isFileUnchangedByMtime, getOrCreateFile, insertSymbol, insertEdge +7 more
- `src/main/codex/hooks.ts` — createCodexHooks
- `src/main/codex/index.ts` — CodexManager, acquireManager, releaseManager
- `src/main/codex/indexer-worker.ts`
- `src/main/codex/indexer.ts` — reindexFile, runIndexInWorker, IndexStats, IndexProgress, indexProjectSync
- `src/main/codex/manager.ts` — CodexManager, acquireManager, releaseManager
- `src/main/codex/mcp-server.ts` — createCodexMcpServer
- `src/main/codex/parser.ts` — getLanguage, isSupportedFile, hashFile, parseFile, ExtractedParam, ExtractedSymbol, ExtractedImport, ExtractedCall +2 more
- `src/main/codex/query.ts` — brief, preEditContext, search, getCallers, getContext, getImpact, getDeps, getRank +21 more
- `src/main/codex/watcher.ts` — CodexWatcher, startWatcher
- `src/main/file-system.ts` — readDirectory, readFileContent, writeFileContent, getGitStatus, getGitDiff, getGitStatusDetailed, gitStage, gitUnstage +3 more
- `src/main/index.ts`
- `src/main/ipc.ts` — registerIpcHandlers
- `src/main/keystore.ts` — setApiKey, getApiKey, removeApiKey, hasApiKey
- `src/main/logger.ts` — log
- `src/main/providers/claude-provider.ts` — ClaudeProvider
- `src/main/providers/copilot-provider.ts` — createCopilotProvider
- `src/main/providers/gemini-provider.ts` — createGeminiProvider
- `src/main/providers/index.ts` — createProvider, ProviderDriver, ClaudeProvider, detectProviders, setApiKeyGetter, ProviderHandle, ModelInfo, PermissionHandler +1 more
- `src/main/providers/jsonl-provider.test.ts`
- `src/main/providers/jsonl-provider.ts` — JsonlProvider, JsonlProviderConfig, extractTextFromJson
- `src/main/providers/openai-provider.ts` — createOpenAIProvider
- `src/main/providers/provider.ts` — ModelInfo, ProviderHandle, PermissionHandler, SendPromptOptions, ProviderDriver
- `src/main/terminal-parser.test.ts`
- `src/main/terminal.ts` — setMainWindow, getOrCreateTerminal, getBuffer, writeToTerminal, writeToAgentTerminal, resizeTerminal, closeTerminal, closeAgentTerminal +4 more
- `src/main/updater.ts` — checkForUpdates, setMainWindow, initAutoUpdater, downloadUpdate, installUpdate
- `src/preload/index.ts` — API
- `src/renderer/App.tsx` — App
- `src/renderer/ThemeContext.tsx` — useTheme, ThemeProvider
- `src/renderer/components/activity/FileActivitySidebar.tsx` — FileActivitySidebar
- `src/renderer/components/activity/FileDetailModal.tsx` — FileDetailModal
- `src/renderer/components/activity/FileExplorer.tsx` — FileExplorer
- `src/renderer/components/chat/ConversationPanel.tsx` — ConversationPanel
- `src/renderer/components/chat/MarkdownRenderer.tsx`
- `src/renderer/components/grid/AgentCell.tsx` — AgentCell, AgentCell
- `src/renderer/components/grid/AgentGrid.tsx` — AgentGrid
- `src/renderer/components/grid/AgentTabs.tsx` — AgentTabs
- `src/renderer/components/grid/FluidBackground.tsx` — FluidBackground
- `src/renderer/components/grid/MinimizedAgentsPill.tsx` — MinimizedAgentsPill
- `src/renderer/components/journey/JourneyBar.tsx` — JourneyBar
- `src/renderer/components/palette/CommandPalette.tsx` — CommandPalette
- `src/renderer/components/palette/HelpOverlay.tsx` — HelpOverlay
- `src/renderer/components/palette/SessionPicker.tsx` — SessionPicker
- `src/renderer/components/palette/ShortcutOverlay.tsx` — ShortcutOverlay
- `src/renderer/components/palette/commands.ts` — slashCommands, keyboardShortcuts, paletteCommands, resolveAlias
- `src/renderer/components/scm/ContextMenu.tsx` — ContextMenuItem, ContextMenu
- `src/renderer/components/scm/DiffView.tsx` — DiffView
- `src/renderer/components/scm/SourceControlSidebar.tsx` — SourceControlSidebar, SourceControlSidebar
- `src/renderer/components/settings/ProviderSection.tsx` — ProviderSection
- `src/renderer/components/settings/SettingsPanel.tsx` — SettingsPanel
- `src/renderer/components/settings/ThemePicker.tsx` — ThemePicker
- `src/renderer/components/settings/UpdateSection.tsx` — UpdateSection
- `src/renderer/components/shared/ConfirmDialog.tsx` — ConfirmDialog
- `src/renderer/components/shared/DiffDisplay.tsx` — DiffHunkHeader, DiffLineRow, CollapsedContext, ExpandableContext, DiffHunkHeader, DiffLineRow, CollapsedContext, ExpandableContext
- `src/renderer/components/shared/diff-utils.test.ts`
- `src/renderer/components/shared/diff-utils.ts` — DiffLine, computeLineDiff, splitIntoHunks, newFileDiffLines, deletedFileDiffLines, countDiffLines
- `src/renderer/components/terminal/Terminal.tsx` — TerminalPanel
- `src/renderer/components/terminal/TerminalDrawer.tsx` — TerminalDrawer
- `src/renderer/hooks/useAgent.ts` — useAgent, clearAgentCache
- `src/renderer/hooks/useAgentManager.ts` — saveSession, useAgentManager
- `src/renderer/hooks/useApiUsage.ts` — useApiUsage, UsageAPIData
- `src/renderer/hooks/useAuth.ts` — useAuth
- `src/renderer/hooks/useContextUsage.ts` — useContextUsage
- `src/renderer/hooks/useFileActivity.ts` — useFileActivity
- `src/renderer/hooks/useJourneyPhase.ts` — useJourneyPhase
- ... and 15 more files

## Codex MCP Tools — USE THESE
test
This project has a live code index via MCP. **Always prefer these over grep/ripgrep for structural queries.** They are faster, rank-aware, and understand code relationships.

### When to use which tool

**Finding code** — use instead of Grep/Glob:
- `search_code` — find symbols by name or description (PageRank-ranked). Use this FIRST for any "where is X" or "find X" query.
- `find_files` — find files by glob pattern (e.g. `**/*.test.ts`). Use instead of shell find/ls.
- `get_file_map` — full project map with every file and its exports. Use to orient yourself in an unfamiliar codebase.

**Before modifying code** — always check impact:
- `get_symbol` — full context for a symbol (code, deps, dependents, co-located symbols). Read this before editing any function/class.
- `get_callers` — all callers of a function. Check before renaming, changing signatures, or deleting.
- `get_dependents` — all files transitively affected if a file changes. Check before refactoring exports.
- `get_dependencies` — what a symbol imports/uses.

**Understanding structure:**
- `get_file_symbols` — all symbols in a file (not just exports).
- `find_by_kind` — find all classes, interfaces, enums, etc. across the project.
- `get_type_hierarchy` — subclasses/implementors of a class or interface.
- `get_pkg_usages` — files that import a given npm package (use before swapping libraries).
- `get_architecture` — project overview with top symbols and module dependency map.

**Maintenance:**
- `find_dead_exports` — exported symbols nothing imports (dead code candidates).
- `reindex_file` — re-index a file after major edits to keep results fresh.
- `review_diff` — graph-aware diff review: changed symbols, callers, blast radius, risks.

### Decision guide

| You want to... | Use this | Not this |
|---|---|---|
| Find a function/class | `search_code` | Grep/ripgrep |
| Find files by name | `find_files` | shell find/ls/Glob |
| See what a file exports | `get_file_symbols` | Read entire file |
| Check who calls X | `get_callers` | Grep for function name |
| Understand blast radius | `get_dependents` | Manual file tracing |
| Find a literal string/regex | Grep (built-in) | — |

## Development Cycle — FOLLOW THIS

For every code change, follow this cycle. Do not skip steps.

### 1. Understand (before touching anything)
- Run `search_code` or `get_file_map` to locate the relevant code.
- Run `get_symbol` on every function/class you plan to modify — read its full context, dependencies, and dependents.
- Run `get_callers` on any function whose signature, behavior, or name will change. Know who depends on it.
- Run `get_dependents` on any file whose exports will change. Know the blast radius.
- If unfamiliar with the area, run `get_architecture` to see how modules connect.

### 2. Plan (decide what to change)
- From step 1, you now know: what the code does, who calls it, and what breaks if it changes.
- Identify all files and symbols that need updating (not just the primary target — include callers/dependents that must adapt).
- If the change affects >3 files or an exported API, state the plan before writing code.

### 3. Implement (make the change)
- Edit the code. Prefer minimal, targeted changes.
- Update all callers/dependents identified in step 2 — do not leave broken references.
- After major edits to a file, run `reindex_file` so subsequent queries reflect your changes.

### 4. Verify (confirm nothing broke)
- Run `get_callers` again on modified symbols — verify every caller still works with the new signature/behavior.
- Run `get_dependents` on modified files — verify no import is left broken.
- Run tests if they exist (`npm test`, `pytest`, etc.).
- If the project has a build step, run it (`npm run build`, `tsc --noEmit`, etc.).

### 5. Review (before committing)
- Run `review_diff` with target "staged" or "last_commit" to get a graph-aware review of your changes.
- Check the risk assessment: high-importance symbols modified, cascade risks, broken imports.
- If risks are flagged, go back to step 4 and address them.

### Quick reference

| Step | Tools | Gate |
|---|---|---|
| Understand | `search_code`, `get_symbol`, `get_callers`, `get_dependents` | Know the blast radius |
| Plan | (your reasoning) | All affected files identified |
| Implement | Edit + `reindex_file` | Code written |
| Verify | `get_callers`, `get_dependents`, tests, build | No broken refs, tests pass |
| Review | `review_diff` | No unaddressed risks |

*Auto-generated by claude-ex. Run `claude-ex generate-docs` to regenerate.*
<!-- claude-ex:end -->
