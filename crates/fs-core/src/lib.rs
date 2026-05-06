//! fs-core — shared types for the FluidState TUI
//!
//! All data structures shared across crates live here: agent descriptors,
//! terminal IDs, application events, key actions, and configuration.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

pub fn uid() -> String {
    Uuid::new_v4().to_string()[..8].to_string()
}

pub type AgentId = String;
pub type TerminalId = String;

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Provider {
    Claude,
    Codex,
    Copilot,
    Gemini,
    Terminal,
}

impl Provider {
    pub fn label(self) -> &'static str {
        match self {
            Self::Claude => "Claude",
            Self::Codex => "Codex",
            Self::Copilot => "Copilot",
            Self::Gemini => "Gemini",
            Self::Terminal => "Terminal",
        }
    }

    pub fn short(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Copilot => "copilot",
            Self::Gemini => "gemini",
            Self::Terminal => "terminal",
        }
    }
}

impl Default for Provider {
    fn default() -> Self {
        Self::Claude
    }
}

impl std::fmt::Display for Provider {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.label())
    }
}

// ---------------------------------------------------------------------------
// Agent types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentDescriptor {
    pub id: AgentId,
    pub name: String,
    pub cwd: String,
    pub provider: Provider,
}

// ---------------------------------------------------------------------------
// Key actions — high-level commands triggered by keyboard shortcuts
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyAction {
    NewAgent,
    NewAgentInFolder,
    NewAgentWithProvider(Provider),
    CloseAgent,
    FocusAgent(usize), // 0-indexed
    FocusNext,
    FocusPrev,
    TogglePalette,
    Quit,
    None,
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct Config {
    pub max_agents: usize,
}

impl Default for Config {
    fn default() -> Self {
        Self { max_agents: 9 }
    }
}
