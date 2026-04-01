/// Agent management — spawns the `claude` CLI subprocess and streams JSONL output.
///
/// Protocol (print + stream-json mode):
///   stdin  ← permission responses (JSONL)
///   stdout → JSONL messages (system, assistant, stream_event, result, permission_request, …)
///
/// Each agent runs its own tokio task. The stop_tx broadcast channel aborts it.
use std::collections::HashMap;
use std::sync::Arc;
use std::path::PathBuf;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::{broadcast, oneshot};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

use crate::state::{AppState, PendingPermission, PermissionResponse};

// ---------------------------------------------------------------------------
// CLI detection
// ---------------------------------------------------------------------------

pub fn find_claude_cli() -> Option<PathBuf> {
    // 1. Env var override
    if let Ok(p) = std::env::var("FLUIDSTATE_CLAUDE_PATH") {
        let pb = PathBuf::from(&p);
        if pb.exists() { return Some(pb); }
    }

    // 2. `which claude`
    if let Ok(p) = which::which("claude") {
        return Some(p);
    }

    // 3. Known macOS install locations
    let home = dirs::home_dir().unwrap_or_default();
    let candidates = [
        home.join(".claude").join("local").join("claude"),
        home.join(".claude").join("bin").join("claude"),
        home.join(".npm-global").join("bin").join("claude"),
        PathBuf::from("/usr/local/bin/claude"),
        PathBuf::from("/opt/homebrew/bin/claude"),
    ];
    for c in &candidates {
        if c.exists() { return Some(c.clone()); }
    }

    None
}

// ---------------------------------------------------------------------------
// Clean environment (mirror buildCleanEnv from TypeScript)
// ---------------------------------------------------------------------------

fn build_clean_env() -> HashMap<String, String> {
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
    env
}

// ---------------------------------------------------------------------------
// UI message types (mirroring TypeScript UIMessage)
// ---------------------------------------------------------------------------

fn uid() -> String {
    Uuid::new_v4().to_string()[..8].to_string()
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

// ---------------------------------------------------------------------------
// JSONL message parsing → UIMessage events
// ---------------------------------------------------------------------------

#[derive(Debug, serde::Serialize, Clone)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum UiMessage {
    System  { id: String, text: String, ts: u64 },
    Assistant { id: String, text: String, #[serde(rename = "isStreaming")] is_streaming: bool, ts: u64 },
    #[serde(rename = "tool-use")]
    ToolUse { id: String, #[serde(rename = "toolName")] tool_name: String, #[serde(rename = "toolUseId")] tool_use_id: String, input: serde_json::Value, ts: u64 },
    #[serde(rename = "tool-progress")]
    ToolProgress { id: String, #[serde(rename = "toolName")] tool_name: String, #[serde(rename = "toolUseId")] tool_use_id: String, elapsed: f64, ts: u64 },
    #[serde(rename = "token-usage")]
    TokenUsage { id: String, #[serde(rename = "inputTokens")] input_tokens: u64, #[serde(rename = "outputTokens")] output_tokens: u64, ts: u64 },
    Usage { id: String, utilization: f64, #[serde(rename = "resetsAt")] resets_at: Option<u64>, #[serde(rename = "limitType")] limit_type: String, status: String, ts: u64 },
    Error { id: String, message: String, ts: u64 },
    Result { id: String, cost: f64, duration: u64, #[serde(rename = "numTurns")] num_turns: u64, ts: u64 },
}

struct StreamingState {
    id: String,
    text: String,
}

fn parse_sdk_message(
    msg: &serde_json::Value,
    streaming: &mut Option<StreamingState>,
    session_id_out: &mut Option<String>,
) -> Vec<UiMessage> {
    let mut out = Vec::new();
    let msg_type = msg["type"].as_str().unwrap_or("");

    match msg_type {
        "system" => {
            let subtype = msg["subtype"].as_str().unwrap_or("");
            match subtype {
                "init" => {
                    let model = msg["model"].as_str().unwrap_or("Claude");
                    out.push(UiMessage::System {
                        id: uid(), text: format!("Connected · {model}"), ts: now_ms(),
                    });
                }
                "status" if msg["status"] == "compacting" => {
                    out.push(UiMessage::System { id: uid(), text: "Compacting context...".into(), ts: now_ms() });
                }
                "task_started" => {
                    if let Some(desc) = msg["description"].as_str() {
                        out.push(UiMessage::System { id: uid(), text: format!("Task: {desc}"), ts: now_ms() });
                    }
                }
                "task_notification" => {
                    let status = msg["status"].as_str().unwrap_or("");
                    let summary = msg["summary"].as_str().unwrap_or("");
                    out.push(UiMessage::System { id: uid(), text: format!("Task {status}: {summary}"), ts: now_ms() });
                }
                "local_command_output" => {
                    let content = msg["content"].as_str().unwrap_or("");
                    out.push(UiMessage::System { id: uid(), text: content.into(), ts: now_ms() });
                }
                _ => {}
            }
        }

        "assistant" => {
            *streaming = None;
            if let Some(content) = msg["message"]["content"].as_array() {
                for block in content {
                    match block["type"].as_str() {
                        Some("text") => {
                            let text = block["text"].as_str().unwrap_or("").to_string();
                            out.push(UiMessage::Assistant { id: uid(), text, is_streaming: false, ts: now_ms() });
                        }
                        Some("tool_use") => {
                            out.push(UiMessage::ToolUse {
                                id: uid(),
                                tool_name: block["name"].as_str().unwrap_or("").to_string(),
                                tool_use_id: block["id"].as_str().unwrap_or("").to_string(),
                                input: block["input"].clone(),
                                ts: now_ms(),
                            });
                        }
                        _ => {}
                    }
                }
            }
            if let (Some(inp), Some(out_t)) = (
                msg["message"]["usage"]["input_tokens"].as_u64(),
                msg["message"]["usage"]["output_tokens"].as_u64(),
            ) {
                out.push(UiMessage::TokenUsage { id: uid(), input_tokens: inp, output_tokens: out_t, ts: now_ms() });
            }
        }

        "stream_event" => {
            let event = &msg["event"];
            let etype = event["type"].as_str().unwrap_or("");
            match etype {
                "content_block_start" => {
                    let block = &event["content_block"];
                    match block["type"].as_str() {
                        Some("text") => {
                            let id = uid();
                            let text = block["text"].as_str().unwrap_or("").to_string();
                            *streaming = Some(StreamingState { id: id.clone(), text: text.clone() });
                            out.push(UiMessage::Assistant { id, text, is_streaming: true, ts: now_ms() });
                        }
                        Some("tool_use") => {
                            out.push(UiMessage::ToolUse {
                                id: uid(),
                                tool_name: block["name"].as_str().unwrap_or("").to_string(),
                                tool_use_id: block["id"].as_str().unwrap_or("").to_string(),
                                input: serde_json::json!({}),
                                ts: now_ms(),
                            });
                        }
                        _ => {}
                    }
                }
                "content_block_delta" if event["delta"]["type"] == "text_delta" => {
                    let delta = event["delta"]["text"].as_str().unwrap_or("");
                    if let Some(s) = streaming {
                        s.text.push_str(delta);
                        out.push(UiMessage::Assistant {
                            id: s.id.clone(), text: s.text.clone(), is_streaming: true, ts: now_ms(),
                        });
                    }
                }
                "message_stop" | "content_block_stop" => {
                    if let Some(s) = streaming.take() {
                        if !s.text.is_empty() {
                            out.push(UiMessage::Assistant {
                                id: s.id, text: s.text, is_streaming: false, ts: now_ms(),
                            });
                        }
                    }
                }
                "message_delta" => {
                    if let (Some(inp), Some(outt)) = (
                        event["usage"]["input_tokens"].as_u64(),
                        event["usage"]["output_tokens"].as_u64(),
                    ) {
                        out.push(UiMessage::TokenUsage { id: uid(), input_tokens: inp, output_tokens: outt, ts: now_ms() });
                    }
                }
                _ => {}
            }
        }

        "tool_progress" => {
            out.push(UiMessage::ToolProgress {
                id: uid(),
                tool_name: msg["tool_name"].as_str().unwrap_or("").to_string(),
                tool_use_id: msg["tool_use_id"].as_str().unwrap_or("").to_string(),
                elapsed: msg["elapsed_time_seconds"].as_f64().unwrap_or(0.0),
                ts: now_ms(),
            });
        }

        "tool_use_summary" => {
            let summary = msg["summary"].as_str().unwrap_or("").to_string();
            out.push(UiMessage::System { id: uid(), text: summary, ts: now_ms() });
        }

        "result" => {
            if let Some(sid) = msg["session_id"].as_str() {
                *session_id_out = Some(sid.to_string());
            }
            if msg["is_error"].as_bool().unwrap_or(false) {
                let err = msg["errors"].as_array()
                    .map(|a| a.iter().filter_map(|v| v.as_str()).collect::<Vec<_>>().join("\n"))
                    .or_else(|| msg["result"].as_str().map(|s| s.to_string()))
                    .unwrap_or_else(|| "Unknown error".to_string());
                out.push(UiMessage::Error { id: uid(), message: err, ts: now_ms() });
            } else {
                out.push(UiMessage::Result {
                    id: uid(),
                    cost: msg["total_cost_usd"].as_f64().unwrap_or(0.0),
                    duration: msg["duration_ms"].as_u64().unwrap_or(0),
                    num_turns: msg["num_turns"].as_u64().unwrap_or(0),
                    ts: now_ms(),
                });
            }
            if let (Some(inp), Some(outt)) = (
                msg["usage"]["input_tokens"].as_u64(),
                msg["usage"]["output_tokens"].as_u64(),
            ) {
                out.push(UiMessage::TokenUsage { id: uid(), input_tokens: inp, output_tokens: outt, ts: now_ms() });
            }
        }

        "rate_limit_event" => {
            let info = &msg["rate_limit_info"];
            if info["status"] == "rejected" {
                let resets_in = info["resetsAt"].as_u64()
                    .map(|t| format!(" — resets in {}m", (t * 1000).saturating_sub(now_ms()) / 60000))
                    .unwrap_or_default();
                out.push(UiMessage::Error { id: uid(), message: format!("Rate limited{resets_in}"), ts: now_ms() });
            }
            if let Some(util) = info["utilization"].as_f64() {
                out.push(UiMessage::Usage {
                    id: uid(),
                    utilization: util,
                    resets_at: info["resetsAt"].as_u64().map(|t| t * 1000),
                    limit_type: info["rateLimitType"].as_str().unwrap_or("unknown").to_string(),
                    status: info["status"].as_str().unwrap_or("allowed").to_string(),
                    ts: now_ms(),
                });
            }
        }

        "auth_status" => {
            if let Some(err) = msg["error"].as_str() {
                out.push(UiMessage::Error { id: uid(), message: format!("Auth error: {err}. Use /login to sign in."), ts: now_ms() });
            } else if let Some(email) = msg["account"]["email"].as_str() {
                out.push(UiMessage::System { id: uid(), text: format!("Signed in as {email}"), ts: now_ms() });
            }
        }

        _ => {}
    }

    out
}

// ---------------------------------------------------------------------------
// Event payloads
// ---------------------------------------------------------------------------

#[derive(serde::Serialize, Clone)]
struct AgentMessagePayload {
    #[serde(rename = "agentId")]
    agent_id: String,
    #[serde(flatten)]
    msg: UiMessage,
}

#[derive(serde::Serialize, Clone)]
struct SessionEvent {
    #[serde(rename = "agentId")]
    agent_id: String,
    #[serde(rename = "sessionId")]
    session_id: String,
}

#[derive(serde::Serialize, Clone)]
struct PermissionRequestPayload {
    #[serde(rename = "agentId")]
    agent_id: String,
    #[serde(rename = "requestId")]
    request_id: String,
    #[serde(rename = "toolName")]
    tool_name: String,
    pub input: serde_json::Value,
    #[serde(rename = "decisionReason")]
    decision_reason: Option<String>,
    pub suggestions: Vec<serde_json::Value>,
}

#[derive(serde::Serialize, Clone)]
struct PermissionDismissedPayload {
    #[serde(rename = "agentId")]
    agent_id: String,
    #[serde(rename = "requestId")]
    request_id: String,
}

// ---------------------------------------------------------------------------
// Session runner — runs as a background tokio task
// ---------------------------------------------------------------------------

pub struct SessionOptions {
    pub resume_session_id: Option<String>,
    pub continue_session: bool,
    pub permission_mode: String,
}

pub async fn run_session(
    app: AppHandle,
    agent_id: String,
    prompt: String,
    cwd: String,
    options: SessionOptions,
    state: Arc<AppState>,
    session_id: String,
) {
    let cli = match find_claude_cli() {
        Some(p) => p,
        None => {
            emit_error(&app, &agent_id, "Claude CLI not found. Install Claude Code or set FLUIDSTATE_CLAUDE_PATH.");
            emit_session_ended(&app, &agent_id, &session_id);
            return;
        }
    };

    // Build command
    let mut cmd = Command::new(&cli);
    cmd.arg("--print").arg(&prompt)
        .arg("--output-format").arg("stream-json")
        .arg("--permission-mode").arg(&options.permission_mode)
        .current_dir(&cwd)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .envs(build_clean_env());

    if let Some(ref resume_id) = options.resume_session_id {
        cmd.arg("--resume").arg(resume_id);
    } else if options.continue_session {
        cmd.arg("--continue");
    }

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            emit_error(&app, &agent_id, &format!("Failed to spawn claude: {e}"));
            emit_session_ended(&app, &agent_id, &session_id);
            return;
        }
    };

    let mut stdin = child.stdin.take().expect("stdin");
    let stdout = child.stdout.take().expect("stdout");

    // Register stop channel
    let (stop_tx, mut stop_rx) = broadcast::channel::<()>(1);
    {
        let mut agents = state.agents.lock().await;
        if let Some(a) = agents.get_mut(&agent_id) {
            a.stop_tx = Some(stop_tx.clone());
            a.is_active = true;
        }
    }

    // Channel to route permission responses back to stdin writer
    let (perm_tx, mut perm_rx) = tokio::sync::mpsc::unbounded_channel::<String>();

    // Stdin writer task: drains perm_rx and writes each line to stdin
    let stdin_task = tokio::spawn(async move {
        while let Some(line) = perm_rx.recv().await {
            if stdin.write_all(line.as_bytes()).await.is_err() { break; }
            if stdin.write_all(b"\n").await.is_err() { break; }
            let _ = stdin.flush().await;
        }
    });

    // Stdout reader + message parser
    let reader = BufReader::new(stdout);
    let mut lines = reader.lines();
    let mut streaming: Option<StreamingState> = None;
    let mut captured_session_id: Option<String> = None;

    let ai = agent_id.clone();
    let si = session_id.clone();
    let app2 = app.clone();
    let state2 = state.clone();

    let read_task = tokio::spawn(async move {
        loop {
            tokio::select! {
                line = lines.next_line() => {
                    match line {
                        Ok(Some(l)) if !l.trim().is_empty() => {
                            let Ok(msg) = serde_json::from_str::<serde_json::Value>(&l) else { continue; };

                            // Permission request — route to renderer and await response
                            if msg["type"] == "permission_request" {
                                let request_id = msg["request_id"].as_str().unwrap_or("").to_string();
                                let tool_name = msg["tool_name"].as_str().unwrap_or("").to_string();
                                let input = msg["input"].clone();
                                let decision_reason = msg["decision_reason"].as_str().map(|s| s.to_string());
                                let suggestions = msg["suggestions"].as_array().cloned().unwrap_or_default();

                                let (resp_tx, resp_rx) = oneshot::channel::<PermissionResponse>();

                                // Register pending permission
                                {
                                    let mut agents = state2.agents.lock().await;
                                    if let Some(a) = agents.get_mut(&ai) {
                                        a.pending_permissions.insert(request_id.clone(), PendingPermission {
                                            tx: resp_tx,
                                            original_input: input.clone(),
                                        });
                                    }
                                }

                                let _ = app2.emit("agent://permission-request", PermissionRequestPayload {
                                    agent_id: ai.clone(),
                                    request_id: request_id.clone(),
                                    tool_name,
                                    input,
                                    decision_reason,
                                    suggestions,
                                });

                                // Wait for response (2 minute timeout)
                                let resp = tokio::time::timeout(
                                    std::time::Duration::from_secs(120),
                                    resp_rx,
                                ).await;

                                let behavior = match resp {
                                    Ok(Ok(r)) => r,
                                    _ => {
                                        // Timeout or channel drop → deny
                                        let _ = app2.emit("agent://permission-dismissed", PermissionDismissedPayload {
                                            agent_id: ai.clone(),
                                            request_id: request_id.clone(),
                                        });
                                        PermissionResponse { behavior: "deny".into(), updated_input: None, updated_permissions: None }
                                    }
                                };

                                // Write permission response to stdin via channel
                                let resp_json = serde_json::json!({
                                    "request_id": request_id,
                                    "behavior": behavior.behavior,
                                    "updated_input": behavior.updated_input,
                                    "updated_permissions": behavior.updated_permissions,
                                });
                                let _ = perm_tx.send(resp_json.to_string());
                                continue;
                            }

                            // Regular message — parse and emit
                            let ui_msgs = parse_sdk_message(&msg, &mut streaming, &mut captured_session_id);
                            for ui_msg in ui_msgs {
                                let _ = app2.emit("agent://message", AgentMessagePayload {
                                    agent_id: ai.clone(),
                                    msg: ui_msg,
                                });
                            }
                        }
                        Ok(None) => break, // EOF
                        Ok(Some(_)) => {}  // empty line
                        Err(_) => break,
                    }
                }
                _ = stop_rx.recv() => {
                    break;
                }
            }
        }

        // Store captured session_id back into agent state
        if let Some(sid) = captured_session_id {
            let mut agents = state2.agents.lock().await;
            if let Some(a) = agents.get_mut(&ai) {
                a.session_id = Some(sid);
            }
        }
    });

    // Wait for read task to finish, then kill child if still running
    let _ = read_task.await;
    let _ = child.kill().await;
    // perm_tx was moved into the read_task closure; the channel closes when read_task ends.
    let _ = stdin_task.await;

    // Mark agent inactive, clear stop channel
    {
        let mut agents = state.agents.lock().await;
        if let Some(a) = agents.get_mut(&agent_id) {
            a.is_active = false;
            a.stop_tx = None;
            // Dismiss any lingering permission requests
            for (req_id, _) in a.pending_permissions.drain() {
                let _ = app.emit("agent://permission-dismissed", PermissionDismissedPayload {
                    agent_id: agent_id.clone(),
                    request_id: req_id,
                });
            }
        }
    }

    emit_session_ended(&app, &agent_id, &session_id);
}

// ---------------------------------------------------------------------------
// List sessions (calls `claude --list-sessions --output-format json`)
// ---------------------------------------------------------------------------

#[derive(serde::Serialize, serde::Deserialize)]
pub struct SessionInfo {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    pub summary: Option<String>,
    #[serde(rename = "lastModified")]
    pub last_modified: u64,
    pub cwd: Option<String>,
}

pub async fn list_claude_sessions(cwd: Option<&str>) -> Vec<SessionInfo> {
    let Some(cli) = find_claude_cli() else { return vec![] };
    let mut cmd = Command::new(&cli);
    cmd.arg("--list-sessions")
       .arg("--output-format").arg("json");
    if let Some(c) = cwd {
        cmd.current_dir(c);
    }
    cmd.stdout(std::process::Stdio::piped())
       .stderr(std::process::Stdio::null());

    let output = match cmd.output().await {
        Ok(o) => o,
        Err(_) => return vec![],
    };

    serde_json::from_slice::<Vec<SessionInfo>>(&output.stdout).unwrap_or_default()
}

pub async fn get_session_messages(session_id: &str, cwd: Option<&str>) -> Vec<serde_json::Value> {
    let Some(cli) = find_claude_cli() else { return vec![] };
    let mut cmd = Command::new(&cli);
    cmd.arg("--session").arg(session_id)
       .arg("--output-format").arg("json");
    if let Some(c) = cwd {
        cmd.current_dir(c);
    }
    cmd.stdout(std::process::Stdio::piped())
       .stderr(std::process::Stdio::null());

    let output = match cmd.output().await {
        Ok(o) => o,
        Err(_) => return vec![],
    };

    serde_json::from_slice::<Vec<serde_json::Value>>(&output.stdout).unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn emit_error(app: &AppHandle, agent_id: &str, message: &str) {
    let _ = app.emit("agent://message", AgentMessagePayload {
        agent_id: agent_id.to_string(),
        msg: UiMessage::Error { id: uid(), message: message.to_string(), ts: now_ms() },
    });
}

fn emit_session_ended(app: &AppHandle, agent_id: &str, session_id: &str) {
    let _ = app.emit("agent://session-ended", SessionEvent {
        agent_id: agent_id.to_string(),
        session_id: session_id.to_string(),
    });
}
