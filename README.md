# FS Code

Web-based IDE that wraps the [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI. Monaco editor, file explorer, terminal, and real-time AI agent sessions — all in the browser.

## Prerequisites

- [Bun](https://bun.sh) (v1.0+)
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated (`claude auth login`)
- Node.js 18+ (for Vite)

## Setup

```bash
git clone https://github.com/vihaanshahh/fs-code.git
cd fs-code
bun install
```

## Running locally

### Development (hot reload)

```bash
bun run dev
```

This starts:
- Vite dev server on `http://localhost:5173` (frontend with HMR)
- Hono API server on `http://localhost:5174` (backend)

Open `http://localhost:5173` in your browser.

### Production

```bash
bun run build
bun run start
```

Open `http://localhost:5174`.

## Configuration

| Environment variable | Default | Description |
|---|---|---|
| `WORKSPACE_ROOT` | current directory | Root directory the file explorer and agents operate in |
| `PORT` | `5174` | API server port |
| `CLAUDE_PATH` | `claude` | Path to the Claude Code CLI binary |

Example:

```bash
WORKSPACE_ROOT=~/my-project bun run dev
```

## How it works

When you create an agent, the server spawns:

```
claude -p "<your task>" --output-format stream-json --verbose --dangerously-skip-permissions
```

Output is parsed and streamed to the browser via SSE. When an agent finishes, you can send follow-up messages that resume the same Claude session.

### Agent features

- Real-time streaming of Claude's responses and tool calls
- Tool call visualization (Bash, Read, Edit, Grep, etc.) with expandable details
- Session resume — send follow-up messages to idle agents
- Cost tracking per agent
- Stop/remove agents at any time

## Project structure

```
src/
├── main.tsx              # React entry
├── App.tsx               # Layout, state, SSE connections
├── types/index.ts        # Shared TypeScript types
├── components/
│   ├── Editor.tsx        # Monaco editor with tabs
│   ├── FileExplorer.tsx  # File tree with context menu
│   ├── AgentPanel.tsx    # Agent list + detail view with chat
│   └── Terminal.tsx      # Shell terminal
└── server/
    └── index.ts          # Hono API (files, agents, terminal)
```

## Testing without real API calls

To test the UI without consuming API credits, you can point `CLAUDE_PATH` to a script that echoes mock stream-json output:

```bash
cat > /tmp/mock-claude.sh << 'SCRIPT'
#!/bin/bash
echo '{"type":"system","subtype":"init","session_id":"mock-123","model":"claude-sonnet-4-20250514","cwd":"/tmp"}'
sleep 1
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"I will help you with that task."}]}}'
sleep 1
echo '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","id":"tool_1","input":{"command":"echo hello world"}}]}}'
sleep 1
echo '{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0.003,"result":"Done."}'
SCRIPT
chmod +x /tmp/mock-claude.sh

CLAUDE_PATH=/tmp/mock-claude.sh bun run dev
```
