//! Private tmux workspaces used to keep FluidState terminals alive while the
//! TUI is not running.  This deliberately uses a private socket: FluidState
//! must never inspect, alter, or accidentally kill a user's normal tmux server.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{anyhow, Context};

#[derive(Debug, Clone)]
pub struct TmuxWorkspace {
    socket: PathBuf,
    prefix: String,
}

impl TmuxWorkspace {
    pub fn available() -> bool {
        which::which("tmux").is_ok()
    }

    /// `key` must be a stable, filesystem-independent project identifier.
    pub fn new(key: &str) -> anyhow::Result<Self> {
        let base = std::env::var_os("XDG_RUNTIME_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir)
            .join("fluidstate");
        std::fs::create_dir_all(&base)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&base, std::fs::Permissions::from_mode(0o700))?;
        }
        Ok(Self {
            socket: base.join(format!("{}.sock", &key[..key.len().min(24)])),
            prefix: format!("fs_{}", &key[..key.len().min(16)]),
        })
    }

    pub fn session_name(&self, agent_id: &str) -> String {
        format!("{}_{}", self.prefix, agent_id)
    }

    pub fn socket(&self) -> &Path { &self.socket }

    fn command(&self) -> Command {
        let mut command = Command::new("tmux");
        command.arg("-S").arg(&self.socket).arg("-f").arg("/dev/null");
        command
    }

    fn run(&self, args: &[String]) -> anyhow::Result<()> {
        let status = self.command().args(args).status()
            .with_context(|| "failed to start tmux")?;
        if status.success() { Ok(()) } else { Err(anyhow!("tmux command failed: {:?}", args)) }
    }

    /// Create a detached one-pane session, or leave an existing session alone.
    /// tmux, not FluidState, owns the agent process after this returns.
    #[allow(clippy::too_many_arguments)] // Inputs are passed directly as separate tmux arguments.
    pub fn ensure_session(
        &self,
        session: &str,
        program: &str,
        program_args: &[String],
        cwd: &str,
        env: &HashMap<String, String>,
        agent_id: &str,
        provider: &str,
        name: &str,
    ) -> anyhow::Result<()> {
        if self.command().args(["has-session", "-t", session]).status()
            .map(|s| s.success()).unwrap_or(false) {
            return Ok(());
        }

        // A newly created private server has no socket yet, so `set-option`
        // cannot be the first command. `new-session` below starts it. tmux's
        // default 2000-line history is already finite for that first window;
        // the explicit global cap applies to every later window.
        let mut args = vec!["new-session".into(), "-d".into(), "-s".into(), session.into(), "-c".into(), cwd.into()];
        for (key, value) in env {
            args.push("-e".into());
            args.push(format!("{key}={value}"));
        }
        args.push(program.into());
        args.extend(program_args.iter().cloned());
        self.run(&args)?;
        self.run(&["set-option".into(), "-g".into(), "history-limit".into(), "100000".into()])?;
        self.run(&["set-option".into(), "-t".into(), session.into(), "status".into(), "off".into()])?;
        self.run(&["set-option".into(), "-t".into(), session.into(), "remain-on-exit".into(), "on".into()])?;
        // Store enough metadata in tmux to repair a missing JSON manifest.
        for (option, value) in [("@fluidstate_agent_id", agent_id), ("@fluidstate_provider", provider), ("@fluidstate_name", name)] {
            self.run(&["set-option".into(), "-p".into(), "-t".into(), format!("{session}:0.0"), option.into(), value.into()])?;
        }
        Ok(())
    }

    pub fn attach_command(&self, session: &str) -> (String, Vec<String>) {
        ("tmux".into(), vec!["-S".into(), self.socket.to_string_lossy().into_owned(), "attach-session".into(), "-t".into(), session.into()])
    }

    pub fn close_session(&self, session: &str) {
        let _ = self.command().args(["kill-session", "-t", session]).status();
    }

    pub fn session_exists(&self, session: &str) -> bool {
        self.command().args(["has-session", "-t", session]).status().map(|s| s.success()).unwrap_or(false)
    }
}
