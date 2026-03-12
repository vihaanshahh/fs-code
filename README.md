# FS Code

Electron IDE built on the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk). Full Claude Code capabilities with a visual interface — Monaco editor, file explorer, agent chat panel, and terminal.

## Prerequisites

- [Bun](https://bun.sh) (v1.0+)
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated (`claude auth login`)
- Node.js 18+

## Setup

```bash
git clone https://github.com/vihaanshahh/fs-code.git
cd fs-code
bun install
```

## Development

```bash
bun run dev
```

Opens the Electron app with hot reload for the renderer.

## Production build

```bash
bun run build
bun run start
```

## Architecture

```
src/
├── main/                    # Electron main process
│   ├── index.ts             # Window creation, lifecycle
│   ├── agent.ts             # Claude Agent SDK integration
│   ├── ipc.ts               # IPC handler registration
│   ├── file-system.ts       # File read/write for explorer
│   └── terminal.ts          # Shell process management
├── preload/
│   └── index.ts             # contextBridge API
├── renderer/                # React app
│   ├── App.tsx              # Main layout
│   ├── components/
│   │   ├── chat/            # Agent conversation panel
│   │   ├── editor/          # Monaco editor
│   │   ├── explorer/        # File tree
│   │   └── terminal/        # Terminal emulator
│   └── hooks/               # useAgent, useEditor, useFileTree
└── shared/
    └── types.ts             # IPC contract types
```

### How it works

The main process uses the Agent SDK's `query()` function with `AsyncIterable<SDKUserMessage>` input for multi-turn conversations. Messages stream back as `SDKMessage` events and are forwarded to the renderer via IPC.

- **Auth**: Inherits from Claude Code's existing authentication
- **Permissions**: Tool permission requests are forwarded to the UI as approval dialogs
- **Streaming**: `includePartialMessages: true` enables real-time token streaming
- **Tools**: All Claude Code tools (Bash, Read, Edit, Grep, etc.) work through the SDK
