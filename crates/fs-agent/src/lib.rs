//! fs-agent — Claude CLI detection, environment setup, and session management.
//!
//! Ported from src-tauri/src/agent.rs. For the TUI, agents run interactively
//! inside PTY terminals (no --print mode). This crate handles CLI discovery
//! and building the clean environment for spawning.

use std::collections::HashMap;
use std::path::PathBuf;

// ---------------------------------------------------------------------------
// CLI detection — find the `claude` binary
// ---------------------------------------------------------------------------

pub fn find_claude_cli() -> Option<PathBuf> {
    // 1. Env var override
    if let Ok(p) = std::env::var("FLUIDSTATE_CLAUDE_PATH") {
        let pb = PathBuf::from(&p);
        if pb.exists() {
            return Some(pb);
        }
    }

    // 2. `which claude`
    if let Ok(p) = which::which("claude") {
        return Some(p);
    }

    // 3. Known install locations
    let home = dirs::home_dir().unwrap_or_default();
    let candidates = [
        home.join(".claude/local/claude"),
        home.join(".claude/bin/claude"),
        home.join(".npm-global/bin/claude"),
        PathBuf::from("/usr/local/bin/claude"),
        PathBuf::from("/opt/homebrew/bin/claude"),
    ];
    for c in &candidates {
        if c.exists() {
            return Some(c.clone());
        }
    }

    None
}

/// Find the codex CLI binary.
pub fn find_codex_cli() -> Option<PathBuf> {
    which::which("codex").ok()
}

// ---------------------------------------------------------------------------
// Clean environment — filter out Electron/Vite vars, ensure PATH is complete
// ---------------------------------------------------------------------------

pub fn build_clean_env() -> HashMap<String, String> {
    let mut env: HashMap<String, String> = std::env::vars()
        .filter(|(k, _)| {
            !k.starts_with("ELECTRON")
                && k != "VITE_TAURI"
                && k != "npm_config_cache"
                && k != "npm_lifecycle_script"
        })
        .collect();

    // Ensure PATH includes common tool locations
    let path = env.get("PATH").cloned().unwrap_or_default();
    let extras = "/usr/local/bin:/opt/homebrew/bin";
    if !path.contains(extras) {
        env.insert("PATH".into(), format!("{extras}:{path}"));
    }
    env.insert("TERM".into(), "xterm-256color".into());
    env
}

// ---------------------------------------------------------------------------
// Command builder — construct the claude CLI command for a PTY
// ---------------------------------------------------------------------------

/// Build arguments for launching claude interactively in a PTY.
pub fn claude_args(resume_session: Option<&str>) -> Vec<String> {
    let mut args = Vec::new();
    if let Some(session_id) = resume_session {
        args.push("--resume".into());
        args.push(session_id.into());
    }
    args
}

/// Build arguments for launching codex interactively in a PTY.
pub fn codex_args() -> Vec<String> {
    vec!["--no-alt-screen".into()]
}
