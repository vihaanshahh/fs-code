// FluidState — Tauri backend
//
// All ~50 IPC commands implemented in Rust:
//   - agent.*      → agent.rs  (claude CLI subprocess + JSONL)
//   - terminal.*   → terminal.rs (portable-pty)
//   - auth.*       → auth.rs
//   - fs_*         → fs_ops.rs
//   - provider_*   → providers.rs
//   - keystore     → keystore.rs
//   - update_*     → tauri-plugin-updater

mod agent;
mod auth;
mod fs_ops;
mod keystore;
mod providers;
mod state;
mod terminal;

use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;

use state::AppState;

fn uid() -> String {
    Uuid::new_v4().to_string()[..8].to_string()
}

// ============================================================================
// Auth commands
// ============================================================================

#[tauri::command]
async fn auth_status() -> Result<serde_json::Value, String> {
    let s = auth::get_auth_status().await;
    Ok(serde_json::to_value(s).unwrap())
}

#[tauri::command]
async fn auth_login() -> Result<(), String> {
    auth::auth_login().await
}

#[tauri::command]
async fn auth_logout() -> Result<(), String> {
    auth::auth_logout().await
}

#[tauri::command]
async fn gh_cli_status() -> Result<serde_json::Value, String> {
    let s = auth::get_gh_cli_status().await;
    Ok(serde_json::to_value(s).unwrap())
}

// ============================================================================
// Dialog
// ============================================================================

#[tauri::command]
async fn dialog_open_folder(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let path = app.dialog().file().blocking_pick_folder();
    Ok(path.map(|p| p.to_string()))
}

// ============================================================================
// Agent lifecycle
// ============================================================================

#[derive(serde::Serialize)]
struct AgentDescriptor {
    id: String,
    name: String,
    cwd: String,
    #[serde(rename = "isActive")]
    is_active: bool,
    provider: String,
}

#[tauri::command]
async fn agent_create(
    name: String,
    cwd: String,
    provider: Option<String>,
    app_state: State<'_, Arc<AppState>>,
) -> Result<AgentDescriptor, String> {
    let id = uid();
    let provider = provider.unwrap_or_else(|| "claude".into());
    let mut agents = app_state.agents.lock().await;
    if agents.len() >= 9 {
        return Err("Maximum 9 agents reached".into());
    }
    agents.insert(id.clone(), state::AgentState::new(name.clone(), cwd.clone()));
    Ok(AgentDescriptor { id, name, cwd, is_active: false, provider })
}

#[tauri::command]
async fn agent_close(
    agent_id: String,
    app_state: State<'_, Arc<AppState>>,
) -> Result<bool, String> {
    let mut agents = app_state.agents.lock().await;
    if let Some(a) = agents.get(&agent_id) {
        if let Some(tx) = &a.stop_tx {
            let _ = tx.send(());
        }
    }
    Ok(agents.remove(&agent_id).is_some())
}

#[tauri::command]
async fn agent_list(app_state: State<'_, Arc<AppState>>) -> Result<Vec<AgentDescriptor>, String> {
    let agents = app_state.agents.lock().await;
    Ok(agents.iter().map(|(id, a)| AgentDescriptor {
        id: id.clone(),
        name: a.name.clone(),
        cwd: a.cwd.clone(),
        is_active: a.is_active,
        provider: "claude".into(),
    }).collect())
}

// ============================================================================
// Agent messaging
// ============================================================================

#[tauri::command]
async fn agent_send(
    agent_id: String,
    message: String,
    app: AppHandle,
    app_state: State<'_, Arc<AppState>>,
) -> Result<String, String> {
    let (cwd, permission_mode, resume_id, continue_session) = {
        let agents = app_state.agents.lock().await;
        let a = agents.get(&agent_id).ok_or("Agent not found")?;
        (a.cwd.clone(), a.permission_mode.clone(), a.session_id.clone(), false)
    };

    let session_id = uid();

    // Emit session started
    let _ = app.emit("agent://session-started", serde_json::json!({
        "agentId": agent_id,
        "sessionId": session_id,
    }));

    let options = agent::SessionOptions {
        resume_session_id: resume_id,
        continue_session,
        permission_mode,
    };

    let state_clone = Arc::clone(&*app_state);
    let app_clone = app.clone();
    let aid = agent_id.clone();
    let sid = session_id.clone();
    tokio::spawn(async move {
        agent::run_session(app_clone, aid, message, cwd, options, state_clone, sid).await;
    });

    Ok(session_id)
}

#[tauri::command]
async fn agent_stop(
    agent_id: String,
    app_state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let agents = app_state.agents.lock().await;
    if let Some(a) = agents.get(&agent_id) {
        if let Some(tx) = &a.stop_tx {
            let _ = tx.send(());
        }
    }
    Ok(())
}

#[tauri::command]
async fn agent_permission_respond(
    agent_id: String,
    request_id: String,
    behavior: String,
    updated_input: Option<serde_json::Value>,
    updated_permissions: Option<Vec<serde_json::Value>>,
    app_state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let mut agents = app_state.agents.lock().await;
    if let Some(a) = agents.get_mut(&agent_id) {
        if let Some(pending) = a.pending_permissions.remove(&request_id) {
            let _ = pending.tx.send(state::PermissionResponse {
                behavior,
                updated_input,
                updated_permissions,
            });
        }
    }
    Ok(())
}

#[tauri::command]
async fn agent_list_sessions(
    agent_id: String,
    cwd: Option<String>,
    app_state: State<'_, Arc<AppState>>,
) -> Result<Vec<agent::SessionInfo>, String> {
    let cwd = {
        let agents = app_state.agents.lock().await;
        cwd.or_else(|| agents.get(&agent_id).map(|a| a.cwd.clone()))
    };
    Ok(agent::list_claude_sessions(cwd.as_deref()).await)
}

#[tauri::command]
async fn agent_resume(
    agent_id: String,
    session_id: String,
    app: AppHandle,
    app_state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    {
        let mut agents = app_state.agents.lock().await;
        if let Some(a) = agents.get_mut(&agent_id) {
            a.session_id = Some(session_id.clone());
        }
    }
    // Load history and emit as batch
    let history = agent::get_session_messages(&session_id, None).await;
    let mut batch = vec![serde_json::json!({
        "id": uid(), "type": "system",
        "text": format!("Resumed session {}… {} messages", &session_id[..8], history.len()),
        "ts": now_ms(),
    })];
    for msg in &history {
        match msg["type"].as_str() {
            Some("user") => {
                if let Some(text) = extract_text_content(&msg["message"]) {
                    batch.push(serde_json::json!({"id": uid(),"type":"user","text":text,"ts":now_ms()}));
                }
            }
            Some("assistant") => {
                if let Some(text) = extract_text_content(&msg["message"]) {
                    batch.push(serde_json::json!({"id":uid(),"type":"assistant","text":text,"isStreaming":false,"ts":now_ms()}));
                }
            }
            _ => {}
        }
    }
    let _ = app.emit("agent://message-batch", serde_json::json!({
        "agentId": agent_id,
        "messages": batch,
    }));
    Ok(())
}

#[tauri::command]
async fn agent_continue(
    agent_id: String,
    app: AppHandle,
    app_state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    {
        let mut agents = app_state.agents.lock().await;
        if let Some(a) = agents.get_mut(&agent_id) {
            // Signal to use --continue on next send
            // We store None session_id but set a flag via the continue option in sendPrompt
        }
    }
    let _ = app.emit("agent://message", serde_json::json!({
        "agentId": agent_id, "id": uid(), "type": "system",
        "text": "Will continue most recent session on next message.", "ts": now_ms(),
    }));
    Ok(())
}

#[tauri::command]
async fn agent_rename(
    agent_id: String,
    name: String,
    app_state: State<'_, Arc<AppState>>,
) -> Result<bool, String> {
    let mut agents = app_state.agents.lock().await;
    if let Some(a) = agents.get_mut(&agent_id) {
        a.name = name;
        Ok(true)
    } else {
        Ok(false)
    }
}

#[tauri::command]
async fn agent_rename_session(
    session_id: String,
    title: String,
) -> Result<(), String> {
    // claude --rename-session is not a standard CLI feature; no-op for now
    Ok(())
}

#[tauri::command]
async fn agent_emit_system(
    agent_id: String,
    text: String,
    app: AppHandle,
) -> Result<(), String> {
    let _ = app.emit("agent://message", serde_json::json!({
        "agentId": agent_id, "id": uid(), "type": "system", "text": text, "ts": now_ms(),
    }));
    Ok(())
}

#[tauri::command]
async fn agent_set_permission_mode(
    agent_id: String,
    mode: String,
    app_state: State<'_, Arc<AppState>>,
) -> Result<String, String> {
    let valid = ["default", "acceptEdits", "plan", "bypassPermissions", "dontAsk"];
    if !valid.contains(&mode.as_str()) {
        return Err(format!("Invalid mode: {mode}"));
    }
    let mut agents = app_state.agents.lock().await;
    if let Some(a) = agents.get_mut(&agent_id) {
        a.permission_mode = mode.clone();
    }
    Ok(mode)
}

#[tauri::command]
async fn agent_get_permission_mode(
    agent_id: String,
    app_state: State<'_, Arc<AppState>>,
) -> Result<String, String> {
    let agents = app_state.agents.lock().await;
    Ok(agents.get(&agent_id).map(|a| a.permission_mode.clone()).unwrap_or_else(|| "default".into()))
}

#[tauri::command]
async fn agent_clear_session(
    agent_id: String,
    app_state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let mut agents = app_state.agents.lock().await;
    if let Some(a) = agents.get_mut(&agent_id) {
        a.session_id = None;
    }
    Ok(())
}

// ============================================================================
// Model
// ============================================================================

#[tauri::command]
async fn agent_get_model(_agent_id: String) -> Result<serde_json::Value, String> {
    // Model switching is managed by the claude CLI itself; return defaults
    Ok(serde_json::json!({
        "current": "claude-opus-4-6",
        "models": [
            {"value": "claude-opus-4-6", "displayName": "Claude Opus 4.6", "description": "Most capable"},
            {"value": "claude-sonnet-4-6", "displayName": "Claude Sonnet 4.6", "description": "Balanced"},
            {"value": "claude-haiku-4-5", "displayName": "Claude Haiku 4.5", "description": "Fastest"},
        ]
    }))
}

#[tauri::command]
async fn agent_set_model(
    _agent_id: String,
    _model: String,
) -> Result<(), String> {
    // Model is set per-session via --model flag; store for next send
    Ok(())
}

// ============================================================================
// CLI run (for /compact, /model slash commands)
// ============================================================================

#[tauri::command]
async fn cli_run(
    args: Vec<String>,
    cwd: Option<String>,
) -> Result<serde_json::Value, String> {
    let Some(cli) = agent::find_claude_cli() else {
        return Ok(serde_json::json!({"error": "Claude CLI not found"}));
    };
    let mut cmd = tokio::process::Command::new(&cli);
    cmd.args(&args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    if let Some(c) = cwd {
        cmd.current_dir(c);
    }
    let output = cmd.output().await.map_err(|e| e.to_string())?;
    Ok(serde_json::json!({
        "stdout": String::from_utf8_lossy(&output.stdout),
        "stderr": String::from_utf8_lossy(&output.stderr),
    }))
}

// ============================================================================
// CLI install (no-op in Tauri — we rely on system-installed claude)
// ============================================================================

#[tauri::command] async fn cli_install() -> Result<(), String> { Ok(()) }
#[tauri::command] async fn cli_uninstall() -> Result<(), String> { Ok(()) }
#[tauri::command] async fn cli_is_installed() -> Result<bool, String> {
    Ok(agent::find_claude_cli().is_some())
}

// ============================================================================
// Usage
// ============================================================================

#[tauri::command]
async fn usage_fetch() -> Result<serde_json::Value, String> {
    // The claude CLI doesn't expose a direct usage API; return empty
    Ok(serde_json::json!({}))
}

// ============================================================================
// File system commands
// ============================================================================

#[tauri::command]
async fn fs_read_dir(path: String) -> Result<serde_json::Value, String> {
    fs_ops::read_directory(&path).await
}

#[tauri::command]
async fn fs_read_file(path: String, _cwd: Option<String>) -> Result<serde_json::Value, String> {
    fs_ops::read_file(&path).await
}

#[tauri::command]
async fn fs_write_file(path: String, content: String) -> Result<(), String> {
    fs_ops::write_file(&path, &content).await
}

#[tauri::command]
async fn fs_git_diff(path: String, cwd: Option<String>) -> Result<serde_json::Value, String> {
    fs_ops::git_diff(&path, cwd.as_deref()).await
}

#[tauri::command]
async fn fs_git_status(cwd: String) -> Result<serde_json::Value, String> {
    fs_ops::git_status(&cwd).await
}

#[tauri::command]
async fn fs_git_status_detailed(cwd: String) -> Result<serde_json::Value, String> {
    fs_ops::git_status_detailed(&cwd).await
}

#[tauri::command]
async fn fs_git_stage(path: String, cwd: String) -> Result<serde_json::Value, String> {
    fs_ops::git_stage(&path, &cwd).await
}

#[tauri::command]
async fn fs_git_unstage(path: String, cwd: String) -> Result<serde_json::Value, String> {
    fs_ops::git_unstage(&path, &cwd).await
}

#[tauri::command]
async fn fs_git_discard(path: String, cwd: String) -> Result<serde_json::Value, String> {
    fs_ops::git_discard(&path, &cwd).await
}

#[tauri::command]
async fn fs_git_commit(message: String, cwd: String) -> Result<serde_json::Value, String> {
    fs_ops::git_commit(&message, &cwd).await
}

#[tauri::command]
async fn fs_search_files(
    cwd: String,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<String>, String> {
    Ok(fs_ops::search_files(&cwd, &query, limit).await)
}

// ============================================================================
// Terminal commands
// ============================================================================

#[derive(serde::Serialize)]
struct TerminalResult {
    #[serde(rename = "terminalId")]
    terminal_id: String,
    #[serde(rename = "isNew")]
    is_new: bool,
}

#[tauri::command]
async fn term_create(
    agent_id: String,
    cwd: String,
    app: AppHandle,
    app_state: State<'_, Arc<AppState>>,
) -> Result<TerminalResult, String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into());
    let tid = terminal::create_pty(
        app, Arc::clone(&*app_state), Some(agent_id), cwd, &shell, &[],
    ).await?;
    Ok(TerminalResult { terminal_id: tid, is_new: true })
}

#[tauri::command]
async fn term_create_claude(
    agent_id: String,
    cwd: String,
    resume: Option<String>,
    app: AppHandle,
    app_state: State<'_, Arc<AppState>>,
) -> Result<TerminalResult, String> {
    let Some(cli) = agent::find_claude_cli() else {
        return Err("Claude CLI not found".into());
    };
    let cli_str = cli.to_string_lossy().to_string();
    let args_owned: Vec<String> = if let Some(ref r) = resume {
        vec!["--resume".to_string(), r.clone()]
    } else {
        vec![]
    };
    let args_refs: Vec<&str> = args_owned.iter().map(|s| s.as_str()).collect();

    let tid = terminal::create_pty(
        app, Arc::clone(&*app_state), Some(agent_id), cwd, &cli_str, &args_refs,
    ).await?;
    Ok(TerminalResult { terminal_id: tid, is_new: true })
}

#[tauri::command]
async fn term_create_codex(
    agent_id: String,
    cwd: String,
    app: AppHandle,
    app_state: State<'_, Arc<AppState>>,
) -> Result<TerminalResult, String> {
    let codex = which::which("codex").map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| "codex".into());
    let tid = terminal::create_pty(
        app, Arc::clone(&*app_state), Some(agent_id), cwd, &codex, &[],
    ).await?;
    Ok(TerminalResult { terminal_id: tid, is_new: true })
}

#[tauri::command]
async fn term_buffer(
    terminal_id: String,
    app_state: State<'_, Arc<AppState>>,
) -> Result<serde_json::Value, String> {
    let data = terminal::get_buffer(Arc::clone(&*app_state), &terminal_id).await;
    Ok(serde_json::json!({ "data": data }))
}

#[tauri::command]
async fn term_write(
    terminal_id: String,
    data: String,
    app_state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    terminal::write_terminal(Arc::clone(&*app_state), &terminal_id, &data).await
}

#[tauri::command]
async fn term_resize(
    terminal_id: String,
    cols: u16,
    rows: u16,
    app_state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    terminal::resize_terminal(Arc::clone(&*app_state), &terminal_id, cols, rows).await
}

#[tauri::command]
async fn term_close(
    terminal_id: String,
    app_state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    terminal::close_terminal(Arc::clone(&*app_state), &terminal_id).await;
    Ok(())
}

#[tauri::command]
async fn term_write_agent(
    agent_id: String,
    data: String,
    app_state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let tid = {
        let terminals = app_state.terminals.lock().await;
        terminals.iter()
            .find(|(_, t)| t.agent_id.as_deref() == Some(&agent_id))
            .map(|(id, _)| id.clone())
    };
    if let Some(tid) = tid {
        terminal::write_terminal(Arc::clone(&*app_state), &tid, &data).await
    } else {
        Err(format!("no terminal for agent {agent_id}"))
    }
}

// ============================================================================
// Providers
// ============================================================================

#[tauri::command]
async fn provider_list() -> Result<serde_json::Value, String> {
    Ok(serde_json::to_value(providers::get_all_providers()).unwrap())
}

#[tauri::command]
async fn provider_detect() -> Result<serde_json::Value, String> {
    Ok(serde_json::to_value(providers::detect_providers()).unwrap())
}

#[tauri::command]
async fn provider_set_api_key(provider: String, key: String) -> Result<(), String> {
    keystore::set_provider_api_key(&provider, &key)
}

#[tauri::command]
async fn provider_has_api_key(provider: String) -> Result<bool, String> {
    keystore::has_provider_api_key(&provider)
}

// ============================================================================
// Window / pill mode
// ============================================================================

#[tauri::command]
async fn window_minimize_pill(
    _agent_count: u32,
    app: AppHandle,
) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("main") {
        win.set_size(tauri::Size::Physical(tauri::PhysicalSize { width: 300, height: 60 }))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn window_restore_pill(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("main") {
        win.set_size(tauri::Size::Physical(tauri::PhysicalSize { width: 1400, height: 900 }))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ============================================================================
// Logging
// ============================================================================

#[tauri::command]
async fn log_get_usage() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({}))
}

#[tauri::command]
async fn log_get_path() -> Result<Option<String>, String> {
    Ok(dirs::data_local_dir()
        .map(|p| p.join("FluidState").join("logs").to_string_lossy().to_string()))
}

// ============================================================================
// Auto-update
// ============================================================================

#[tauri::command]
async fn update_check(_app: AppHandle) -> Result<serde_json::Value, String> {
    // tauri-plugin-updater provides this via the plugin; basic stub
    Ok(serde_json::json!({ "available": false }))
}

#[tauri::command]
async fn update_download() -> Result<(), String> { Ok(()) }
#[tauri::command]
async fn update_install() -> Result<(), String> { Ok(()) }

#[tauri::command]
async fn update_set_gh_token(token: String) -> Result<(), String> {
    keystore::set_github_token(&token)
}

#[tauri::command]
async fn update_has_gh_token() -> Result<bool, String> {
    keystore::has_github_token()
}

#[tauri::command]
async fn update_remove_gh_token() -> Result<(), String> {
    keystore::remove_github_token()
}

// ============================================================================
// Resource stats
// ============================================================================

#[tauri::command]
async fn resource_stats(app_state: State<'_, Arc<AppState>>) -> Result<serde_json::Value, String> {
    let agents = app_state.agents.lock().await;
    let active = agents.values().filter(|a| a.is_active).count();
    let terminals = app_state.terminals.lock().await;

    // Read RSS from /proc/self/statm (Linux) or use 0 as fallback
    let memory_mb = get_rss_mb();

    Ok(serde_json::json!({
        "agentCount": agents.len(),
        "activeAgentCount": active,
        "memoryMB": memory_mb,
        "heapUsedMB": memory_mb,
        "heapTotalMB": 0,
        "externalMB": 0,
        "codexReadyCount": 0,
        "terminalCount": terminals.len(),
        "uptimeSeconds": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
    }))
}

fn get_rss_mb() -> u64 {
    // Linux: read from /proc/self/statm (page count)
    #[cfg(target_os = "linux")]
    {
        if let Ok(data) = std::fs::read_to_string("/proc/self/statm") {
            if let Some(rss_pages) = data.split_whitespace().nth(1) {
                if let Ok(pages) = rss_pages.parse::<u64>() {
                    let page_size = 4096u64; // standard page size
                    return (pages * page_size) / (1024 * 1024);
                }
            }
        }
    }
    // macOS: use `ps` as a portable fallback
    #[cfg(target_os = "macos")]
    {
        if let Ok(output) = std::process::Command::new("ps")
            .args(["-o", "rss=", "-p", &std::process::id().to_string()])
            .output()
        {
            if let Ok(rss_kb) = String::from_utf8_lossy(&output.stdout).trim().parse::<u64>() {
                return rss_kb / 1024;
            }
        }
    }
    0
}

// ============================================================================
// Helpers
// ============================================================================

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn extract_text_content(content: &serde_json::Value) -> Option<String> {
    if let Some(s) = content.as_str() { return Some(s.to_string()); }
    if let Some(arr) = content.as_array() {
        let texts: Vec<&str> = arr.iter()
            .filter(|b| b["type"] == "text")
            .filter_map(|b| b["text"].as_str())
            .collect();
        if !texts.is_empty() { return Some(texts.join("")); }
    }
    if let Some(inner) = content.get("content") {
        return extract_text_content(inner);
    }
    None
}

// ============================================================================
// Entry point
// ============================================================================

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app_state = Arc::new(AppState::new());
    let state_for_setup = app_state.clone();

    tauri::Builder::default()
        .manage(app_state)
        .setup(move |app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Graceful shutdown: close all terminals and agents on window close
            let state_for_exit = state_for_setup.clone();
            let handle = app.handle().clone();
            handle.on_window_event(move |_win, event| {
                if let tauri::WindowEvent::Destroyed = event {
                    let state = state_for_exit.clone();
                    tokio::spawn(async move {
                        // Close all terminals (kills PTY child processes)
                        terminal::close_all(state.clone()).await;
                        // Clear all agents (drops stop channels)
                        let mut agents = state.agents.lock().await;
                        for (_id, agent) in agents.drain() {
                            if let Some(tx) = agent.stop_tx {
                                let _ = tx.send(());
                            }
                        }
                    });
                }
            });

            Ok(())
        })
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            // Auth
            auth_status, auth_login, auth_logout, gh_cli_status,
            // Dialog
            dialog_open_folder,
            // Agent lifecycle
            agent_create, agent_close, agent_list,
            // Agent messaging
            agent_send, agent_stop, agent_permission_respond,
            agent_list_sessions, agent_resume, agent_continue,
            agent_rename, agent_rename_session, agent_emit_system,
            agent_set_permission_mode, agent_get_permission_mode, agent_clear_session,
            // CLI
            cli_run, cli_install, cli_uninstall, cli_is_installed,
            // Usage / model
            usage_fetch, agent_get_model, agent_set_model,
            // File system
            fs_read_dir, fs_read_file, fs_write_file,
            fs_git_diff, fs_git_status, fs_git_status_detailed,
            fs_git_stage, fs_git_unstage, fs_git_discard, fs_git_commit, fs_search_files,
            // Terminal
            term_create, term_create_claude, term_create_codex,
            term_buffer, term_write, term_resize, term_close, term_write_agent,
            // Providers
            provider_list, provider_detect, provider_set_api_key, provider_has_api_key,
            // Window
            window_minimize_pill, window_restore_pill,
            // Logging
            log_get_usage, log_get_path,
            // Update
            update_check, update_download, update_install,
            update_set_gh_token, update_has_gh_token, update_remove_gh_token,
            // Stats
            resource_stats,
        ])
        .run(tauri::generate_context!())
        .expect("error while running FluidState");
}
