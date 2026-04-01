use std::sync::Arc;
use std::io::Read;
use tokio::sync::Mutex;
use tauri::{AppHandle, Emitter};
use portable_pty::{CommandBuilder, PtySize, native_pty_system, MasterPty};
use uuid::Uuid;

use crate::state::{AppState, TerminalState};

fn uid() -> String {
    Uuid::new_v4().to_string()[..8].to_string()
}

/// Max scrollback buffer per terminal (~50KB, same as Electron side)
const MAX_BUFFER: usize = 50_000;

/// Batch window for PTY output (ms). Coalesces rapid small reads into
/// fewer IPC events. At 9 terminals streaming, this reduces events from
/// thousands/sec to ~180/sec (9 × 20 flushes/sec).
const FLUSH_MS: u64 = 50;

/// Max bytes per IPC payload. Truncates to tail if exceeded.
const MAX_PENDING: usize = 16_000;

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

/// Create a PTY subprocess. If an agent already has a live terminal, returns
/// the existing terminal ID (idempotent, prevents PTY leaks).
pub async fn create_pty(
    app: AppHandle,
    state: Arc<AppState>,
    agent_id: Option<String>,
    cwd: String,
    program: &str,
    args: &[&str],
) -> Result<String, String> {
    // Check for existing terminal for this agent (idempotent reuse)
    if let Some(ref aid) = agent_id {
        let terminals = state.terminals.lock().await;
        if let Some((tid, _)) = terminals.iter().find(|(_, t)| t.agent_id.as_deref() == Some(aid)) {
            return Ok(tid.clone());
        }
    }

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
    // Pass a clean environment, filtering out Electron-specific vars
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

    // Store the master handle for resize support
    let master: Box<dyn MasterPty + Send> = pair.master;
    let master_arc = Arc::new(Mutex::new(master));

    // Shared buffer for terminal reattach
    let buffer = Arc::new(Mutex::new(String::new()));

    // Register terminal state
    {
        let mut terminals = state.terminals.lock().await;
        terminals.insert(terminal_id.clone(), TerminalState {
            agent_id: agent_id.clone(),
            cwd: cwd.clone(),
            writer: writer_arc,
            master: Arc::clone(&master_arc),
            buffer: Arc::clone(&buffer),
        });
    }

    // Background thread: read PTY output → batch → emit Tauri events
    let mut reader = {
        let m = master_arc.lock().await;
        m.try_clone_reader()
            .map_err(|e| format!("try_clone_reader failed: {e}"))?
    };
    let app_clone = app.clone();
    let state_clone = state.clone();
    let terminal_id_clone = terminal_id.clone();
    let buffer_clone = Arc::clone(&buffer);

    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        let mut pending = String::new();
        let mut last_flush = std::time::Instant::now();

        let flush = |app: &AppHandle, tid: &str, data: &mut String| {
            if data.is_empty() { return; }
            // Truncate to tail if too large
            if data.len() > MAX_PENDING {
                let start = data.len() - MAX_PENDING;
                *data = data[start..].to_string();
            }
            let _ = app.emit("term://data", TermDataPayload {
                terminal_id: tid.to_string(),
                data: data.clone(),
            });
            data.clear();
        };

        loop {
            match reader.read(&mut buf) {
                Ok(0) => {
                    // EOF — flush remaining
                    flush(&app_clone, &terminal_id_clone, &mut pending);
                    break;
                }
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buf[..n]).to_string();

                    // Append to scrollback buffer
                    {
                        // Use try_lock to avoid blocking the read loop
                        if let Ok(mut b) = buffer_clone.try_lock() {
                            b.push_str(&data);
                            if b.len() > MAX_BUFFER {
                                let start = b.len() - MAX_BUFFER;
                                *b = b[start..].to_string();
                            }
                        }
                    }

                    pending.push_str(&data);

                    // Flush if batch window expired or buffer is large
                    let elapsed = last_flush.elapsed().as_millis() as u64;
                    if elapsed >= FLUSH_MS || pending.len() >= MAX_PENDING {
                        flush(&app_clone, &terminal_id_clone, &mut pending);
                        last_flush = std::time::Instant::now();
                    }
                }
                Err(_) => {
                    flush(&app_clone, &terminal_id_clone, &mut pending);
                    break;
                }
            }
        }

        // Terminal exited — get exit code, kill child to prevent zombies
        let code = match child.try_wait() {
            Ok(Some(status)) => status.exit_code() as i32,
            _ => {
                // Still running — kill it
                child.kill().ok();
                child.wait().ok().map(|s| s.exit_code() as i32).unwrap_or(1)
            }
        };

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

/// Get buffered output for a terminal (for replaying on reattach).
pub async fn get_buffer(state: Arc<AppState>, terminal_id: &str) -> String {
    let terminals = state.terminals.lock().await;
    if let Some(term) = terminals.get(terminal_id) {
        let buf = term.buffer.lock().await;
        buf.clone()
    } else {
        String::new()
    }
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
    let terminals = state.terminals.lock().await;
    if let Some(term) = terminals.get(terminal_id) {
        let master = term.master.lock().await;
        master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| format!("resize failed: {e}"))?;
    }
    Ok(())
}

/// Close a terminal — drop the writer so the PTY child gets EOF and exits.
pub async fn close_terminal(state: Arc<AppState>, terminal_id: &str) {
    let mut terminals = state.terminals.lock().await;
    terminals.remove(terminal_id);
    // Dropping TerminalState drops the writer Arc, which (if last ref) closes
    // the PTY master write end. The read thread will get EOF and reap the child.
}

/// Close all terminals — called on app shutdown.
pub async fn close_all(state: Arc<AppState>) {
    let mut terminals = state.terminals.lock().await;
    terminals.clear();
}
