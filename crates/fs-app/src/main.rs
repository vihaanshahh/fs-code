//! FluidState — pure Rust multi-agent TUI IDE.
//!
//! Architecture inspired by Fresh editor (sinelaw/fresh):
//!   - ratatui + crossterm for TUI rendering
//!   - alacritty_terminal for terminal emulation (replaces xterm.js)
//!   - portable-pty for PTY management
//!   - tokio for async runtime
//!
//! Usage:
//!   fluidstate           # launch with current directory
//!   fluidstate /path     # launch with specific directory

use tracing_subscriber::EnvFilter;

fn main() -> anyhow::Result<()> {
    // Initialize tracing (RUST_LOG=info for verbose output)
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("warn")),
        )
        .with_writer(std::io::stderr) // logs go to stderr, TUI goes to stdout
        .init();

    // Build tokio runtime
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;

    // Run the TUI app
    rt.block_on(async {
        let mut app = fs_tui::App::new();
        app.run().await
    })
}
