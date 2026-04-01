use std::sync::Arc;
use tokio::sync::Mutex;
use tauri::{AppHandle, Emitter};
use portable_pty::{CommandBuilder, PtySize, native_pty_system};
use uuid::Uuid;

use crate::state::{AppState, TerminalState};

fn uid() -> String {
    Uuid::new_v4().to_string()[..8].to_string()
}

#[derive(serde::Serialize, Clone)]
struct TermDataPayload {
    #[serde(rename = "terminalId")]
    terminal_id: String,
    data: String,
}

#[derive(serde::Serialize, Clone)]
struct TermExitPayload {
    #[serde(rename = "terminalId")]
    terminal_id: String,
    code: i32,
}

pub async fn create_pty(
    app: AppHandle,
    state: Arc<AppState>,
    agent_id: Option<String>,
    cwd: String,
    program: &str,
    args: &[&str],
) -> Result<String, String> {
    let terminal_id = uid();
    let tid = terminal_id.clone();

    let pair = {
        let pty_system = native_pty_system();
        pty_system.openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| format!("openpty failed: {e}"))?
    };

    let mut cmd = CommandBuilder::new(program);
    for arg in args { cmd.arg(arg); }
    cmd.cwd(&cwd);
    // Pass a clean environment
    cmd.env_clear();
    for (k, v) in std::env::vars() {
        if !k.starts_with("ELECTRON") { cmd.env(k, v); }
    }
    // Ensure TERM is set for proper terminal emulation
    cmd.env("TERM", "xterm-256color");

    let mut child = pair.slave.spawn_command(cmd)
        .map_err(|e| format!("spawn failed: {e}"))?;

    // Writer for the PTY master (renderer → PTY)
    let writer = pair.master.take_writer()
        .map_err(|e| format!("take_writer failed: {e}"))?;
    let writer_arc = Arc::new(Mutex::new(writer));

    // Register terminal state
    {
        let mut terminals = state.terminals.lock().await;
        terminals.insert(terminal_id.clone(), TerminalState {
            agent_id: agent_id.clone(),
            cwd: cwd.clone(),
            writer: writer_arc,
        });
    }

    // Background thread: read PTY output → emit Tauri events
    let mut reader = pair.master.try_clone_reader()
        .map_err(|e| format!("try_clone_reader failed: {e}"))?;
    let app_clone = app.clone();
    let state_clone = state.clone();
    let terminal_id_clone = terminal_id.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buf[..n]).to_string();
                    let _ = app_clone.emit("term://data", TermDataPayload {
                        terminal_id: terminal_id_clone.clone(),
                        data,
                    });
                }
                Err(_) => break,
            }
        }
        // Terminal exited — get exit code
        let code = child.wait().ok().map(|s| s.exit_code() as i32).unwrap_or(0);
        let _ = app_clone.emit("term://exit", TermExitPayload {
            terminal_id: terminal_id_clone.clone(),
            code,
        });
        // Clean up terminal state
        let rt = tokio::runtime::Handle::try_current();
        if let Ok(rt) = rt {
            rt.spawn(async move {
                let mut terminals = state_clone.terminals.lock().await;
                terminals.remove(&terminal_id_clone);
            });
        }
    });

    Ok(tid)
}

/// Write data to a terminal's PTY master input.
pub async fn write_terminal(state: Arc<AppState>, terminal_id: &str, data: &str) -> Result<(), String> {
    let terminals = state.terminals.lock().await;
    let term = terminals.get(terminal_id).ok_or_else(|| format!("terminal {terminal_id} not found"))?;
    let mut writer = term.writer.lock().await;
    use std::io::Write;
    writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    writer.flush().map_err(|e| e.to_string())
}

/// Resize a terminal's PTY.
pub async fn resize_terminal(state: Arc<AppState>, terminal_id: &str, cols: u16, rows: u16) -> Result<(), String> {
    // Note: portable-pty doesn't expose resize on the master directly after creation.
    // This is a best-effort no-op for now; full resize support requires storing the master handle.
    Ok(())
}

/// Close a terminal (remove from state; the PTY thread will exit on next read error).
pub async fn close_terminal(state: Arc<AppState>, terminal_id: &str) {
    let mut terminals = state.terminals.lock().await;
    terminals.remove(terminal_id);
}
