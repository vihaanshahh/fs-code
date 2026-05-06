//! FluidState — pure Rust multi-agent TUI IDE.
//!
//! Architecture inspired by Fresh editor (sinelaw/fresh):
//!   - ratatui + crossterm for TUI rendering
//!   - alacritty_terminal for terminal emulation (replaces xterm.js)
//!   - portable-pty for PTY management
//!   - tokio for async runtime
//!
//! Usage:
//!   fluidstate              # launch with current directory
//!   fluidstate /path        # launch with specific directory
//!   fluidstate update          # check for and install updates
//!   fluidstate update --force  # reinstall the latest release unconditionally
//!   fluidstate version      # print current version

use tracing_subscriber::EnvFilter;

fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();

    // Handle non-TUI subcommands before initializing the terminal.
    match args.first().map(|s| s.as_str()) {
        Some("update") => {
            let force = args.iter().skip(1).any(|a| a == "--force" || a == "-f");
            return run_update(force);
        }
        Some("version" | "--version" | "-V") => {
            println!("fluidstate {}", fs_update::VERSION);
            return Ok(());
        }
        _ => {}
    }

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
        // Background update check — fires and forgets, prints a note on exit if
        // an update is available.
        let update_handle = tokio::spawn(async { fs_update::check_background().await });

        let mut app = fs_tui::App::new();
        let result = app.run().await;

        // After the TUI exits, show update notice if one came back.
        if let Ok(Some(latest)) = update_handle.await {
            eprintln!(
                "\n  A new version of FluidState is available: v{latest} (current: v{})",
                fs_update::VERSION
            );
            eprintln!("  Run `fluidstate update` to install it.\n");
        }

        match result {
            Ok(()) => Ok(()),
            Err(e) => {
                let msg = e.to_string();
                if msg.contains("No such device") || msg.contains("not a terminal") {
                    eprintln!("Error: FluidState requires an interactive terminal (TTY).");
                    eprintln!("Run this command directly in a terminal, not piped or in CI.");
                    std::process::exit(1);
                }
                Err(e)
            }
        }
    })
}

/// Synchronous wrapper that builds a minimal runtime for the update command.
fn run_update(force: bool) -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("warn")),
        )
        .with_writer(std::io::stderr)
        .init();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;

    rt.block_on(async {
        match fs_update::perform_update(force).await {
            Ok(_) => Ok(()),
            Err(e) => {
                eprintln!("Update failed: {e:#}");
                std::process::exit(1);
            }
        }
    })
}
