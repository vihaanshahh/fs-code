use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{Mutex, oneshot};
use portable_pty::MasterPty;

// ---------------------------------------------------------------------------
// Permission handling
// ---------------------------------------------------------------------------

#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct PermissionResponse {
    pub behavior: String,
    pub updated_input: Option<serde_json::Value>,
    pub updated_permissions: Option<Vec<serde_json::Value>>,
}

// ---------------------------------------------------------------------------
// Agent state
// ---------------------------------------------------------------------------

pub struct PendingPermission {
    pub tx: oneshot::Sender<PermissionResponse>,
    pub original_input: serde_json::Value,
}

pub struct AgentState {
    pub name: String,
    pub cwd: String,
    pub session_id: Option<String>,
    pub is_active: bool,
    pub permission_mode: String,
    /// Keyed by request_id
    pub pending_permissions: HashMap<String, PendingPermission>,
    /// Send () to abort the running claude subprocess
    pub stop_tx: Option<tokio::sync::broadcast::Sender<()>>,
}

impl AgentState {
    pub fn new(name: String, cwd: String) -> Self {
        Self {
            name,
            cwd,
            session_id: None,
            is_active: false,
            permission_mode: "default".into(),
            pending_permissions: HashMap::new(),
            stop_tx: None,
        }
    }
}

// ---------------------------------------------------------------------------
// Terminal state
// ---------------------------------------------------------------------------

pub struct TerminalState {
    pub agent_id: Option<String>,
    pub cwd: String,
    /// Sync writer to the PTY master — wrapped in a Mutex for multi-writer safety
    pub writer: Arc<Mutex<Box<dyn std::io::Write + Send>>>,
    /// PTY master handle — needed for resize operations
    pub master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    /// Scrollback buffer for terminal reattach
    pub buffer: Arc<Mutex<String>>,
}

// ---------------------------------------------------------------------------
// Shared application state
// ---------------------------------------------------------------------------

pub struct AppState {
    pub agents: Arc<Mutex<HashMap<String, AgentState>>>,
    pub terminals: Arc<Mutex<HashMap<String, TerminalState>>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            agents: Arc::new(Mutex::new(HashMap::new())),
            terminals: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}
