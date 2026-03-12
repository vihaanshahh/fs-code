# FS Code

Electron IDE built on the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk). Everything Claude Code does, but with a real visual interface instead of the terminal.

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

That's it. The app opens as a native desktop window with:
- **Left sidebar** — file explorer
- **Center** — Monaco code editor
- **Right panel** — Claude agent chat (type a prompt, hit Enter)
- **Bottom** — terminal (toggle with Ctrl+`)

## Auth

FS Code uses your existing Claude Code login. If you've already run `claude auth login`, you're good. The Agent SDK picks up your credentials automatically.

## Commands

| Command | What it does |
|---|---|
| `bun run dev` | Run in dev mode with hot reload |
| `bun run build` | Build for production |
| `bun run start` | Run the production build |

## How it works

The app imports `@anthropic-ai/claude-agent-sdk` in the Electron main process and calls `query()` with streaming input for multi-turn conversations. All SDK messages (text, tool calls, permissions, results) are forwarded to the React renderer via IPC.

- **Streaming** — tokens appear in real-time as Claude thinks
- **Tool calls** — Bash, Read, Edit, Grep, etc. shown as expandable cards
- **Permissions** — when Claude wants to run something, you get an Allow/Deny dialog
- **Session cost** — tracked and shown per conversation

## Project structure

```
src/
├── main/              # Electron main process
│   ├── index.ts       # Window, lifecycle
│   ├── agent.ts       # Agent SDK integration (query, permissions, streaming)
│   ├── ipc.ts         # IPC handlers
│   ├── file-system.ts # File ops for explorer
│   └── terminal.ts    # Shell process
├── preload/
│   └── index.ts       # contextBridge (secure IPC bridge)
├── renderer/          # React UI
│   ├── App.tsx        # Layout
│   ├── components/    # Editor, FileExplorer, ChatPanel, Terminal
│   └── hooks/         # useAgent, useEditor, useFileTree
└── shared/
    └── types.ts       # IPC channel types shared across processes
```
