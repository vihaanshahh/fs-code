//! fs-pty — PTY management + alacritty_terminal emulation.
//!
//! Each agent gets a `TerminalInstance` that owns:
//!   - A portable-pty master (for writing input + resize)
//!   - An alacritty_terminal::Term (for interpreting ANSI output)
//!   - A background reader thread (PTY stdout → Term.process)
//!
//! The TUI renders by calling `term.renderable_content()` which yields
//! cells with characters, colors, and flags — mapped to ratatui styles.

mod instance;
mod manager;
mod tmux;

pub use instance::{EventProxy, TerminalInstance};
pub use manager::TerminalManager;
pub use tmux::TmuxWorkspace;
