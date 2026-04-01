/// Provider detection — finds available AI CLI tools.
use std::collections::HashMap;

#[derive(serde::Serialize, Clone)]
pub struct ProviderConfig {
    pub id: String,
    pub name: String,
    pub description: String,
    #[serde(rename = "authType")]
    pub auth_type: String,
    #[serde(rename = "supportsPermissions")]
    pub supports_permissions: bool,
    #[serde(rename = "supportsResume")]
    pub supports_resume: bool,
}

#[derive(serde::Serialize)]
pub struct ProviderAvailability {
    pub available: bool,
    pub error: Option<String>,
}

pub fn get_all_providers() -> HashMap<String, ProviderConfig> {
    let mut map = HashMap::new();
    map.insert("claude".into(), ProviderConfig {
        id: "claude".into(),
        name: "Claude".into(),
        description: "Anthropic Claude via Claude Code CLI".into(),
        auth_type: "claude".into(),
        supports_permissions: true,
        supports_resume: true,
    });
    map.insert("openai".into(), ProviderConfig {
        id: "openai".into(),
        name: "OpenAI Codex".into(),
        description: "OpenAI Codex CLI".into(),
        auth_type: "api_key".into(),
        supports_permissions: false,
        supports_resume: false,
    });
    map.insert("gemini".into(), ProviderConfig {
        id: "gemini".into(),
        name: "Google Gemini".into(),
        description: "Google Gemini CLI".into(),
        auth_type: "api_key".into(),
        supports_permissions: false,
        supports_resume: false,
    });
    map.insert("copilot".into(), ProviderConfig {
        id: "copilot".into(),
        name: "GitHub Copilot".into(),
        description: "GitHub Copilot CLI".into(),
        auth_type: "github".into(),
        supports_permissions: false,
        supports_resume: false,
    });
    map
}

pub fn detect_providers() -> HashMap<String, ProviderAvailability> {
    let mut result = HashMap::new();

    // claude
    let claude_ok = crate::agent::find_claude_cli().is_some();
    result.insert("claude".into(), ProviderAvailability {
        available: claude_ok,
        error: if claude_ok { None } else { Some("claude CLI not found".into()) },
    });

    // openai / codex
    let codex_ok = which::which("codex").is_ok();
    result.insert("openai".into(), ProviderAvailability {
        available: codex_ok,
        error: if codex_ok { None } else { Some("codex CLI not found".into()) },
    });

    // gemini
    let gemini_ok = which::which("gemini").is_ok();
    result.insert("gemini".into(), ProviderAvailability {
        available: gemini_ok,
        error: if gemini_ok { None } else { Some("gemini CLI not found".into()) },
    });

    // copilot
    let copilot_ok = which::which("github-copilot-cli").is_ok()
        || which::which("gh-copilot").is_ok();
    result.insert("copilot".into(), ProviderAvailability {
        available: copilot_ok,
        error: if copilot_ok { None } else { Some("GitHub Copilot CLI not found".into()) },
    });

    result
}
