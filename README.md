# fluidstate

Multi-agent coding in your terminal. Run parallel coding agents — Claude, Codex, GitHub Copilot, Gemini — or plain shells side-by-side across your codebase, monitor progress in real-time, and only get interrupted when something actually needs you.

→ [fluidstate.ai](https://fluidstate.ai)

## Install

```sh
curl -fsSL https://fluidstate.ai/install.sh | bash
```

Or with Homebrew:

```sh
brew install vihaanshahh/fluidstate/fluidstate
```

Then run it in any project:

```sh
cd your-project
fluidstate
```

At least one of the supported provider CLIs must be installed and signed in:

| Provider | CLI | Install |
|---|---|---|
| Claude | `claude` | `npm i -g @anthropic-ai/claude-code` |
| Codex | `codex` | `npm i -g @openai/codex` |
| Copilot | `copilot` | `npm i -g @github/copilot` |
| Gemini | `gemini` | `npm i -g @google/gemini-cli` |
| Terminal | your `$SHELL` | (already installed) |

The Terminal provider opens a plain interactive shell in a pane — handy for `npm run dev`, lint runs, or anything else you'd reach for a terminal tab for.

## What it is

A pure Rust TUI built on ratatui and alacritty_terminal. No Electron, no Node, no webview — a single binary that runs anywhere you have a terminal.

- **Multi-agent grid** — open multiple agents side-by-side (Claude, Codex, Copilot, Gemini, or plain shells), each with full context in its own pane
- **Live terminal emulation** — real pty, real keystrokes, scrollback, not a log viewer
- **File picker / editor / diff viewer** — browse, open, and diff files without leaving the TUI
- **Command palette** — fuzzy-search everything with a single keypress
- **File tree sidebar** — project navigator with git status indicators
- **Journey bar** — visualizes agent phase (planning → coding → testing → done) across all panes

## Keyboard shortcuts

| Key | Action |
|---|---|
| `Ctrl+N` | New agent pane |
| `Ctrl+W` | Close focused pane |
| `Tab` / `Shift+Tab` | Cycle focus between panes |
| `Ctrl+P` | Command palette |
| `Ctrl+O` | File picker |
| `Ctrl+D` | Diff viewer |
| `Ctrl+E` | Open file in editor |
| `Ctrl+B` | Toggle file tree sidebar |
| `Ctrl+T` | Cycle theme |
| `Ctrl+Q` | Quit |
| `PageUp` / `PageDown` | Scroll terminal output |

## Build from source

```sh
git clone https://github.com/vihaanshahh/fs-code.git
cd fs-code
cargo build --release
./target/release/fluidstate
```

Requires Rust 1.78+.

## Architecture

```
crates/
├── fs-app/      # Binary entry point (main.rs)
├── fs-tui/      # ratatui UI — app loop, grid, palette, overlays, theme
├── fs-agent/    # Claude agent runner (streaming, permissions, tools)
├── fs-pty/      # PTY management via alacritty_terminal + portable-pty
└── fs-core/     # Shared types (AgentDescriptor, Config, KeyAction)
```

Runtime dependencies: none. The binary links only against system libc on Linux. On macOS it is fully self-contained.

## Logging

Logs go to stderr. Set `RUST_LOG=info` (or `debug`) for verbose output:

```sh
RUST_LOG=info fluidstate 2>fluidstate.log
```

## License

MIT
