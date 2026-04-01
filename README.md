# FluidState (fs-code)

A native desktop IDE built on the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk). Everything Claude Code does, but with a real visual interface instead of the terminal — plus multi-provider support, built-in code intelligence, source control, and more.

## What you need

1. **Node.js 18+** — [nodejs.org](https://nodejs.org)
2. **Claude Code CLI** — install and log in:
   ```bash
   npm install -g @anthropic-ai/claude-code
   claude auth login
   ```
3. **Bun** (recommended) or npm — [bun.sh](https://bun.sh)

## Quick start

```bash
# Clone
git clone https://github.com/vihaanshahh/fs-code.git
cd fs-code

# Install dependencies
bun install
# or: npm install

# Run the app (opens Electron window)
bun run dev
# or: npm run dev
```

## Features

### Multi-provider AI

Switch between AI backends without changing your workflow:

- **Claude** — via the Agent SDK (default)
- **OpenAI Codex** — via `codex` CLI
- **Google Gemini** — via `gemini` CLI
- **GitHub Copilot** — via `github-copilot-cli`

Configure providers and API keys in Settings.

### Multi-agent workspace

Run multiple agents side-by-side in a resizable grid. Each agent gets its own pane with independent context, and agents can be minimized to a floating pill to save space.

### Code intelligence (Codex)

A built-in code index that runs automatically in the background:

- **Symbol search** — find functions, classes, and types by name (PageRank-ranked)
- **Dependency tracking** — callers, dependents, imports
- **Live reindex** — file watcher keeps the index fresh as you edit
- **MCP server** — 14 structural analysis tools available to agents during conversations
- **11 languages** — TypeScript, JavaScript, Python, Rust, Go, Bash, C, C++, JSON, CSS, HTML

### Source control

Inline diff viewer with git integration:

- Per-file status (modified, added, deleted, untracked)
- Hunk-based diff visualization
- Stage, unstage, and discard changes from the UI

### Command palette

80+ slash commands across 11 categories. Open with the palette shortcut, search by name, and execute — session management, agent control, view toggles, and more.

### Themes

Seven color themes: Charcoal, Light, Midnight, Rose, Forest, Clay, and Claude. Each includes tuned palettes for phases, diffs, and UI elements.

### Journey bar

Visualizes agent progress through five phases — Thinking, Searching, Planning, Coding, Testing — so you can see at a glance what the agent is doing.

### Auto-updates

Checks GitHub Releases every 30 minutes. Downloads on request, installs on quit. SHA-512 verified.

## Auth

FluidState uses your existing Claude Code login. If you've already run `claude auth login`, you're set — the Agent SDK picks up your credentials automatically.

For other providers, add API keys in Settings. Keys are encrypted via Electron `safeStorage`.

GitHub tokens for private repo access can also be stored in the keystore.

## Commands

| Command | What it does |
|---|---|
| `bun run dev` | Run in dev mode with hot reload |
| `bun run build` | Build for production |
| `bun run start` | Run the production build |
| `bun run test` | Run tests |

## How it works

The main process imports `@anthropic-ai/claude-agent-sdk` and calls `query()` with streaming for multi-turn conversations. All SDK messages (text, tool calls, permissions, results) are forwarded to the React renderer via IPC.

- **Streaming** — tokens appear in real-time as Claude thinks
- **Tool calls** — Bash, Read, Edit, Grep, etc. shown as expandable cards
- **Permissions** — Allow/Deny dialog when the agent wants to run something
- **Session cost** — tracked and displayed per conversation

## Project structure

```
src/
├── main/                  # Electron main process
│   ├── index.ts           # Window, lifecycle
│   ├── agent.ts           # Agent SDK integration (streaming, permissions)
│   ├── ipc.ts             # IPC handlers
│   ├── file-system.ts     # File ops + git integration
│   ├── terminal.ts        # Shell process (node-pty)
│   ├── updater.ts         # Auto-update logic
│   ├── auth.ts            # Claude CLI auth + GitHub tokens
│   ├── keystore.ts        # Encrypted API key storage
│   ├── providers/         # AI provider drivers (Claude, OpenAI, Gemini, Copilot)
│   └── codex/             # Code intelligence engine
│       ├── db.ts          # SQLite index database
│       ├── parser.ts      # Tree-sitter AST extraction
│       ├── indexer.ts      # Full + incremental indexing with PageRank
│       ├── query.ts       # 17 query functions (search, callers, deps, etc.)
│       ├── watcher.ts     # Live file watcher for reindex
│       └── mcp-server.ts  # MCP server with 14 code analysis tools
├── preload/
│   └── index.ts           # contextBridge (secure IPC bridge)
├── renderer/              # React UI
│   ├── App.tsx            # Layout
│   ├── theme.ts           # 7 color themes
│   ├── ThemeContext.tsx    # Theme provider + hook
│   ├── components/
│   │   ├── grid/          # Multi-agent workspace (resizable panes)
│   │   ├── chat/          # Conversation panel + markdown rendering
│   │   ├── scm/           # Source control sidebar + diff viewer
│   │   ├── journey/       # Agent progress visualization
│   │   ├── palette/       # Command palette + shortcuts
│   │   ├── settings/      # Settings panel (providers, themes, updates)
│   │   ├── activity/      # File activity sidebar
│   │   ├── terminal/      # Terminal drawer (xterm.js)
│   │   └── shared/        # Reusable components (diff display, dialogs)
│   └── hooks/             # useAgent, useAgentManager, useAuth, useTheme, etc.
└── shared/
    └── types.ts           # IPC channel types shared across processes
```
