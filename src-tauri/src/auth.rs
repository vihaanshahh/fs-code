/// Authentication status — Claude CLI auth + GitHub CLI auth.
use tokio::process::Command;

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct AuthStatus {
    pub authenticated: bool,
    pub email: Option<String>,
    pub account: Option<String>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct GhCliStatus {
    pub state: String, // "not_installed" | "not_authenticated" | "authenticated"
    pub user: Option<String>,
}

pub async fn get_auth_status() -> AuthStatus {
    let Some(cli) = crate::agent::find_claude_cli() else {
        return AuthStatus { authenticated: false, email: None, account: None };
    };

    // `claude auth status` outputs JSON natively — do NOT add --output-format
    let output = Command::new(&cli)
        .arg("auth").arg("status")
        .env("NO_COLOR", "1")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output().await;

    match output {
        Ok(o) => {
            let stdout = String::from_utf8_lossy(&o.stdout);
            // Parse JSON response: {"loggedIn": true, "email": "...", ...}
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&stdout) {
                let authenticated = v["loggedIn"].as_bool().unwrap_or(false);
                let email = v["email"].as_str().map(|s| s.to_string());
                let account = v["subscriptionType"].as_str().map(|s| s.to_string());
                return AuthStatus { authenticated, email, account };
            }
            // Fallback: text parsing
            let text = stdout.to_string() + "\n" + &String::from_utf8_lossy(&o.stderr);
            let lower = text.to_lowercase();
            if lower.contains("not authenticated") || lower.contains("not logged in") || lower.contains("no valid") {
                return AuthStatus { authenticated: false, email: None, account: None };
            }
            let email = extract_email(&text);
            AuthStatus { authenticated: !text.trim().is_empty(), email, account: None }
        }
        Err(_) => AuthStatus { authenticated: false, email: None, account: None },
    }
}

pub async fn auth_login() -> Result<(), String> {
    let cli = crate::agent::find_claude_cli().ok_or("Claude CLI not found")?;
    Command::new(&cli).arg("auth").arg("login")
        .spawn().map_err(|e| e.to_string())?
        .wait().await.map_err(|e| e.to_string())?;
    Ok(())
}

pub async fn auth_logout() -> Result<(), String> {
    let cli = crate::agent::find_claude_cli().ok_or("Claude CLI not found")?;
    Command::new(&cli).arg("auth").arg("logout")
        .output().await.map_err(|e| e.to_string())?;
    Ok(())
}

pub async fn get_gh_cli_status() -> GhCliStatus {
    let gh = match which::which("gh") {
        Ok(p) => p,
        Err(_) => return GhCliStatus { state: "not_installed".into(), user: None },
    };

    let output = Command::new(&gh)
        .arg("auth").arg("status")
        .env("NO_COLOR", "1")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output().await;

    match output {
        Ok(o) => {
            let text = String::from_utf8_lossy(&o.stdout).to_string()
                + &String::from_utf8_lossy(&o.stderr);
            if o.status.success() || text.contains("Logged in") {
                // Extract username — "Logged in to github.com account USERNAME" or "as USERNAME ("
                let user = extract_gh_user(&text);
                GhCliStatus { state: "authenticated".into(), user }
            } else if text.contains("not logged in") || text.contains("You are not") {
                GhCliStatus { state: "not_authenticated".into(), user: None }
            } else {
                GhCliStatus { state: "not_authenticated".into(), user: None }
            }
        }
        Err(_) => GhCliStatus { state: "not_installed".into(), user: None },
    }
}

fn extract_email(text: &str) -> Option<String> {
    let re = regex::Regex::new(r"[\w.+-]+@[\w.-]+\.\w+").ok()?;
    re.find(text).map(|m| m.as_str().to_string())
}

fn extract_gh_user(text: &str) -> Option<String> {
    // "account USERNAME (" or "as USERNAME ("
    let re1 = regex::Regex::new(r"account (\S+)").ok()?;
    if let Some(c) = re1.captures(text) {
        if let Some(m) = c.get(1) { return Some(m.as_str().to_string()); }
    }
    let re2 = regex::Regex::new(r"as (\S+) \(").ok()?;
    if let Some(c) = re2.captures(text) {
        if let Some(m) = c.get(1) { return Some(m.as_str().to_string()); }
    }
    None
}
