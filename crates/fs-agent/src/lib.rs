//! Shell discovery and a sanitized environment for FluidState terminal tabs.

use std::collections::HashMap;
use std::path::PathBuf;

/// Build an environment for a child shell without variables injected by an
/// Electron or package-manager host process.
pub fn build_clean_env() -> HashMap<String, String> {
    let mut env = std::env::vars()
        .filter(|(key, _)| {
            !key.starts_with("ELECTRON")
                && key != "VITE_TAURI"
                && key != "npm_config_cache"
                && key != "npm_lifecycle_script"
        })
        .collect::<HashMap<_, _>>();
    add_common_unix_paths(&mut env);
    env.insert("TERM".into(), "xterm-256color".into());
    env
}

#[cfg(unix)]
fn add_common_unix_paths(env: &mut HashMap<String, String>) {
    let path = env.get("PATH").cloned().unwrap_or_default();
    let mut additions = Vec::new();
    for directory in ["/usr/local/bin", "/opt/homebrew/bin"] {
        if !path.split(':').any(|item| item == directory) {
            additions.push(directory.to_string());
        }
    }
    if !additions.is_empty() {
        additions.push(path);
        env.insert("PATH".into(), additions.join(":"));
    }
}

#[cfg(windows)]
fn add_common_unix_paths(_env: &mut HashMap<String, String>) {}

/// Find the user's interactive shell, falling back to common system shells.
#[cfg(unix)]
pub fn find_shell() -> PathBuf {
    if let Ok(shell) = std::env::var("SHELL") {
        let path = PathBuf::from(shell);
        if path.exists() {
            return path;
        }
    }
    for shell in ["/bin/zsh", "/bin/bash", "/usr/bin/zsh", "/usr/bin/bash", "/bin/sh"] {
        let path = PathBuf::from(shell);
        if path.exists() {
            return path;
        }
    }
    PathBuf::from("/bin/sh")
}

#[cfg(windows)]
pub fn find_shell() -> PathBuf {
    if let Ok(shell) = std::env::var("COMSPEC") {
        let path = PathBuf::from(shell);
        if path.exists() {
            return path;
        }
    }
    PathBuf::from(r"C:\Windows\System32\cmd.exe")
}

/// Build arguments for a login shell so a new tab matches a regular terminal.
#[cfg(unix)]
pub fn shell_args() -> Vec<String> {
    vec!["-l".into()]
}

#[cfg(windows)]
pub fn shell_args() -> Vec<String> {
    Vec::new()
}
