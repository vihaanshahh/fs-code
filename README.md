# FluidState

Terminal tabs for your project, with a lightweight file tree and no background agent/editor services.

→ [fluidstate.ai](https://fluidstate.ai)

## Install

FluidState installs as one native binary. It has no Node, Electron, provider-CLI, or configuration-file requirement.

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

FluidState opens your existing shell (`$SHELL` / `COMSPEC`) in each tab—use it for dev servers, tests, or anything else you’d do in a terminal.

### Requirements

- macOS, Linux, or Windows on `x86_64` or `aarch64`
- An interactive terminal
- A shell: `$SHELL` on macOS/Linux, or `COMSPEC` on Windows

### Clean removal

Remove the installed `fluidstate` binary from your `PATH`. The application does not create project files or persistent UI/session state. The optional update check stores only a small version cache in the operating system cache directory; it is safe to remove:

```sh
# macOS / Linux
rm -rf "${XDG_CACHE_HOME:-$HOME/.cache}/fluidstate"
```

## What it is

A pure Rust TUI built on ratatui and alacritty_terminal. No Electron, no Node, no webview — a single binary that runs anywhere you have a terminal.

- **Terminal tabs** — open, rename, close, and cycle independent shell sessions
- **Live terminal emulation** — real pty, real keystrokes, scrollback, not a log viewer
- **File tree sidebar** — project navigator with git status indicators
- **Explicit cleanup** — closing a tab kills and reaps its child process, closes its PTY, and joins its reader thread
- **Minimal runtime** — no provider integrations, editor services, session persistence, or project configuration

## Keyboard shortcuts

| Key | Action |
|---|---|
| `Ctrl+N` | New terminal tab |
| `Ctrl+W` | Close focused tab |
| `Ctrl+R` / `F2` | Rename focused tab |
| `Tab` / `Shift+Tab` | Cycle terminal tabs |
| `Ctrl+Left` / `Ctrl+Right` | Cycle terminal tabs |
| `Ctrl+E` | Toggle and focus file tree |
| `Ctrl+Q` | Quit |

## Build from source

```sh
git clone https://github.com/vihaanshahh/fs-code.git
cd fs-code
cargo build --release
./target/release/fluidstate
```

Requires Rust 1.78+.

For a release-equivalent build with no development artifacts in the install location:

```sh
cargo build --release --locked
install -m 755 target/release/fluidstate /usr/local/bin/fluidstate
```

## Architecture

```
crates/
├── fs-app/      # Binary entry point (main.rs)
├── fs-tui/      # ratatui terminal-tab UI, file tree, theme
├── fs-agent/    # shell/environment discovery (std-only)
├── fs-pty/      # PTY management via alacritty_terminal + portable-pty
└── fs-core/     # Shared types (AgentDescriptor, Config, KeyAction)
```

Runtime dependencies: none beyond the system terminal and shell. The binary links only against system libraries on Linux; on macOS it is self-contained.

## Logging

Logs go to stderr. Set `RUST_LOG=info` (or `debug`) for verbose output. The optional background update check uses the OS cache directory noted above and makes no project-directory changes:

```sh
RUST_LOG=info fluidstate 2>fluidstate.log
```

## License

MIT
