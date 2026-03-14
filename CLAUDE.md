<!-- claude-ex:start -->
# Project: fs-code

## Architecture
- **Languages**: tsx (25 files), typescript (24 files), json (5 files), html (1 files)
- **Size**: 55 files, 242 symbols, 1001 relationships

## Key Symbols (by structural importance)
1. `useTheme` [function] in src/renderer/ThemeContext.tsx
2. `API` [type] in src/preload/index.ts
3. `UIMessage` [type] in src/shared/types.ts
4. `PermissionRequest` [interface] in src/shared/types.ts
5. `ThemeColors` [type] in src/renderer/theme.ts
6. `buildPhaseColorMap` [function] in src/renderer/theme.ts
7. `AuthStatus` [interface] in src/shared/types.ts
8. `PermissionResponse` [interface] in src/shared/types.ts
9. `AgentDescriptor` [interface] in src/shared/types.ts
10. `GitFileStatus` [interface] in src/shared/types.ts
11. `FileEntry` [interface] in src/shared/types.ts
12. `PermissionMode` [type] in src/shared/types.ts
13. `SlashCommand` [interface] in src/shared/types.ts
14. `KeyboardShortcut` [interface] in src/shared/types.ts
15. `ThemeMode` [type] in src/renderer/theme.ts

## Module Map
src/ (49 files, 242 symbols) → imports from: (none — leaf dependency)
./ (6 files, 0 symbols) → imports from: (none — leaf dependency)

## File Map (file → key exports)

- `electron.vite.config.ts`
- `package-lock.json`
- `package.json`
- `src/main/agent.ts` — setMainWindow, createAgent, closeAgent, listAgents, sendPrompt, stopSession, setPermissionMode, getPermissionMode +10 more
- `src/main/auth.ts` — getAuthStatus, getClaudePath, ensureClaudeBin, login, logout, fetchUsage
- `src/main/cli-install.ts` — installCLI, uninstallCLI, isCLIInstalled
- `src/main/file-system.ts` — readDirectory, readFileContent, writeFileContent, getGitStatus, getGitDiff, getGitStatusDetailed, gitStage, gitUnstage +2 more
- `src/main/index.ts`
- `src/main/ipc.ts` — registerIpcHandlers
- `src/main/terminal.ts` — closeTerminal, setMainWindow, getOrCreateTerminal, getBuffer, writeToTerminal, resizeTerminal, closeAgentTerminal, closeAll
- `src/preload/index.ts` — API
- `src/renderer/App.tsx` — App
- `src/renderer/ThemeContext.tsx` — useTheme, ThemeProvider
- `src/renderer/components/activity/FileActivitySidebar.tsx` — FileActivitySidebar
- `src/renderer/components/activity/FileDetailModal.tsx` — FileDetailModal
- `src/renderer/components/chat/ConversationPanel.tsx` — ConversationPanel
- `src/renderer/components/chat/MarkdownRenderer.tsx` — MarkdownRenderer
- `src/renderer/components/grid/AddAgentButton.tsx` — AddAgentButton
- `src/renderer/components/grid/AgentCell.tsx` — AgentCell
- `src/renderer/components/grid/AgentGrid.tsx` — AgentGrid
- `src/renderer/components/grid/FluidBackground.tsx` — FluidBackground
- `src/renderer/components/grid/MinimizedAgentsPill.tsx` — MinimizedAgentsPill
- `src/renderer/components/journey/JourneyBar.tsx` — JourneyBar
- `src/renderer/components/palette/CommandPalette.tsx` — CommandPalette
- `src/renderer/components/palette/HelpOverlay.tsx` — HelpOverlay
- `src/renderer/components/palette/SessionPicker.tsx` — SessionPicker
- `src/renderer/components/palette/ShortcutOverlay.tsx` — ShortcutOverlay
- `src/renderer/components/palette/SlashDropdown.tsx` — SlashDropdown
- `src/renderer/components/palette/commands.ts` — slashCommands, keyboardShortcuts, paletteCommands, resolveAlias, aliasMap, PaletteCommand
- `src/renderer/components/scm/ContextMenu.tsx` — ContextMenuItem, ContextMenu
- `src/renderer/components/scm/DiffView.tsx` — DiffView
- `src/renderer/components/scm/SourceControlSidebar.tsx` — SourceControlSidebar
- `src/renderer/components/shared/ConfirmDialog.tsx` — ConfirmDialog
- `src/renderer/components/shared/DiffDisplay.tsx` — DiffHunkHeader, DiffLineRow, CollapsedContext
- `src/renderer/components/shared/diff-utils.ts` — DiffLine, computeLineDiff, splitIntoHunks, newFileDiffLines, deletedFileDiffLines, countDiffLines, DiffHunk
- `src/renderer/components/terminal/Terminal.tsx` — TerminalPanel
- `src/renderer/components/terminal/TerminalDrawer.tsx` — TerminalDrawer
- `src/renderer/hooks/useAgent.ts` — useAgent, clearAgentCache
- `src/renderer/hooks/useAgentManager.ts` — saveSession, useAgentManager
- `src/renderer/hooks/useApiUsage.ts` — useApiUsage, UsageAPIData
- `src/renderer/hooks/useAuth.ts` — useAuth
- `src/renderer/hooks/useContextUsage.ts` — useContextUsage, ContextUsage
- `src/renderer/hooks/useFileActivity.ts` — useFileActivity
- `src/renderer/hooks/useJourneyPhase.ts` — useJourneyPhase
- `src/renderer/hooks/useRecentFolders.ts` — addRecentFolder, getRecentFolders, RecentFolder
- `src/renderer/hooks/useSourceControl.ts` — useSourceControl
- `src/renderer/hooks/useTotalCost.ts` — useTotalCost
- `src/renderer/index.html`
- `src/renderer/lib/api.ts` — api
- `src/renderer/main.tsx`
- `src/renderer/theme.ts` — ThemeColors, ThemeMode, fonts, spacing, lightTheme, darkTheme, phaseLabelMap
- `src/shared/types.ts` — IPC, UIMessage, PermissionRequest, AuthStatus, PermissionResponse, AgentDescriptor, GitFileStatus, FileEntry +13 more
- `tsconfig.json`
- `tsconfig.node.json`
- `tsconfig.web.json`

## Codex MCP Tools — USE THESE

This project has a live code index via MCP. **Always prefer these over grep/ripgrep for structural queries.** They are faster, rank-aware, and understand code relationships.

| Tool | Use for |
|------|---------|
| `search_code` | Finding symbols by name or description (PageRank-weighted) |
| `find_files` | Finding files by name/path pattern (glob-style, e.g. `**/*.test.ts`) |
| `get_file_map` | Complete project map — every file and its exports (the "memory") |
| `get_symbol` | Full context for a symbol before modifying it |
| `get_callers` | Who calls a function — use before renaming/removing |
| `get_dependents` | What files break if a file changes |
| `get_dependencies` | What a symbol imports/uses |
| `get_file_symbols` | All symbols in a file (not just exports) |
| `find_by_kind` | Find all classes, interfaces, enums, etc. |
| `get_type_hierarchy` | Who extends/implements a class or interface |
| `find_dead_exports` | Exported symbols nothing imports (dead code) |
| `get_pkg_usages` | What files import from a given npm/pip package |
| `get_architecture` | Project overview, top symbols, module map |
| `reindex_file` | Re-index a file after major changes |

**Workflow tips:**
- Before editing a function: `get_symbol` + `get_callers` to understand impact
- Before refactoring a file: `get_dependents` to know what breaks
- To find code: `search_code` first (structural), fall back to grep only for literal strings/regex
- To find files: `find_files` with glob patterns (faster than shell find/ls)
- After large changes: `reindex_file` to keep the index fresh

*Auto-generated by claude-ex. Run `claude-ex generate-docs` to regenerate.*
<!-- claude-ex:end -->
