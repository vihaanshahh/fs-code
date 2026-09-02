//! Durable, disk-backed FluidState UI state.  Live terminal state belongs to
//! tmux; this file stores only the information tmux does not know about.

use std::path::{Path, PathBuf};
use fs_core::AgentDescriptor;
use crate::editor::PersistedEditorTab;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct WorkspaceState {
    pub schema_version: u32,
    pub root: String,
    pub agents: Vec<AgentDescriptor>,
    pub focused: usize,
    pub sidebar_open: bool,
    pub editor_split_pct: u16,
    pub editor_focus_mode: bool,
    pub editor_tabs: Vec<PersistedEditorTab>,
    pub active_editor_tab: usize,
}

#[derive(Debug, Clone)]
pub struct Workspace {
    root: String,
    key: String,
    path: PathBuf,
}

impl Workspace {
    pub fn open(root: impl AsRef<Path>) -> Self {
        let root = std::fs::canonicalize(root.as_ref()).unwrap_or_else(|_| root.as_ref().to_path_buf());
        let root = root.to_string_lossy().into_owned();
        let key = stable_key(&root);
        let base = std::env::var_os("XDG_STATE_HOME").map(PathBuf::from)
            .or_else(dirs::data_local_dir)
            .unwrap_or_else(|| std::env::temp_dir().join("fluidstate-state"))
            .join("fluidstate").join("workspaces");
        Self { path: base.join(format!("{key}.json")), root, key }
    }
    pub fn root(&self) -> &str { &self.root }
    pub fn key(&self) -> &str { &self.key }
    pub fn load(&self) -> Option<WorkspaceState> {
        let bytes = std::fs::read(&self.path).ok()?;
        let state: WorkspaceState = serde_json::from_slice(&bytes).ok()?;
        (state.schema_version == 1 && state.root == self.root).then_some(state)
    }
    pub fn save(&self, state: &WorkspaceState) -> anyhow::Result<()> {
        let parent = self.path.parent().expect("workspace state has parent");
        std::fs::create_dir_all(parent)?;
        #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))?; }
        let temporary = self.path.with_extension(format!("json.{}.tmp", std::process::id()));
        let bytes = serde_json::to_vec(state)?;
        {
            use std::io::Write;
            let mut file = std::fs::File::create(&temporary)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
        }
        #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; std::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o600))?; }
        std::fs::rename(temporary, &self.path)?;
        Ok(())
    }
}

fn stable_key(value: &str) -> String {
    // FNV-1a is deliberately specified here (unlike DefaultHasher), so a
    // project keeps the same workspace across FluidState upgrades.
    let mut hash = 0xcbf29ce484222325u64;
    for byte in value.as_bytes() { hash = (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3); }
    format!("{:016x}", hash)
}
