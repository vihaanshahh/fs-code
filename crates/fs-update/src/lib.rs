//! Self-update system for FluidState.
//!
//! Downloads updates from fluidstate.ai which proxies the private GitHub
//! releases. Binary naming convention:
//!   fluidstate-{os}-{arch}        (unix)
//!   fluidstate-{os}-{arch}.exe    (windows)
//!
//! Each release should include a `checksums.sha256` file with lines like:
//!   abcdef1234...  fluidstate-darwin-aarch64

use anyhow::{bail, Context, Result};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::env;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use tempfile::NamedTempFile;
use tracing::{debug, warn};

/// Current version, injected at compile time from Cargo.toml.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Base URL for update API.
const SITE: &str = "https://fluidstate.ai";

/// User-Agent for requests.
const USER_AGENT: &str = concat!("fluidstate-updater/", env!("CARGO_PKG_VERSION"));

// ── API types ────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct LatestRelease {
    tag_name: String,
}

// ── Platform helpers ──────────────────────────────────────────────

fn platform_triple() -> Result<String> {
    let os = match env::consts::OS {
        "macos" => "darwin",
        "linux" => "linux",
        "windows" => "windows",
        other => bail!("unsupported OS: {other}"),
    };
    let arch = match env::consts::ARCH {
        "x86_64" => "x86_64",
        "aarch64" => "aarch64",
        other => bail!("unsupported architecture: {other}"),
    };
    Ok(format!("{os}-{arch}"))
}

fn asset_name() -> Result<String> {
    let triple = platform_triple()?;
    let ext = if cfg!(windows) { ".exe" } else { "" };
    Ok(format!("fluidstate-{triple}{ext}"))
}

// ── Version helpers ───────────────────────────────────────────────

/// Strip leading 'v' from a tag like "v0.7.0" → "0.7.0".
fn normalize_tag(tag: &str) -> &str {
    tag.strip_prefix('v').unwrap_or(tag)
}

/// Simple semver "is `a` < `b`?" for dotted numeric versions.
fn is_newer(current: &str, remote: &str) -> bool {
    let parse =
        |s: &str| -> Vec<u64> { s.split('.').filter_map(|p| p.parse::<u64>().ok()).collect() };
    let a = parse(current);
    let b = parse(remote);
    b > a
}

// ── Public API ────────────────────────────────────────────────────

/// Result of a version check.
#[derive(Debug)]
pub struct VersionCheck {
    pub current: String,
    pub latest: String,
    pub update_available: bool,
}

/// Check for the latest version via fluidstate.ai.
pub async fn check_for_update() -> Result<VersionCheck> {
    let url = format!("{SITE}/api/releases/latest");
    debug!("checking for updates: {url}");

    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(std::time::Duration::from_secs(10))
        .build()?;

    let resp = client.get(&url).send().await?;

    if !resp.status().is_success() {
        return Ok(VersionCheck {
            current: VERSION.to_string(),
            latest: VERSION.to_string(),
            update_available: false,
        });
    }

    let release: LatestRelease = resp.json().await?;
    let latest = normalize_tag(&release.tag_name).to_string();
    let update_available = is_newer(VERSION, &latest);

    Ok(VersionCheck {
        current: VERSION.to_string(),
        latest,
        update_available,
    })
}

/// Path to a cache file that stores the last check result so we don't
/// spam the API on every launch.
fn cache_path() -> Result<PathBuf> {
    let dir = dirs::cache_dir()
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join("fluidstate");
    fs::create_dir_all(&dir)?;
    Ok(dir.join("update-check.json"))
}

#[derive(Debug, Deserialize, serde::Serialize)]
struct CachedCheck {
    latest: String,
    checked_at: u64, // unix secs
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// Non-blocking check that returns `Some(latest_version)` if an update is
/// available and we haven't checked in the last 4 hours. Returns `None`
/// if up-to-date or on any error (never blocks the user).
pub async fn check_background() -> Option<String> {
    // Read cache
    if let Ok(path) = cache_path() {
        if let Ok(data) = fs::read_to_string(&path) {
            if let Ok(cached) = serde_json::from_str::<CachedCheck>(&data) {
                let age = now_secs().saturating_sub(cached.checked_at);
                if age < 4 * 3600 {
                    // Use cached result
                    return if is_newer(VERSION, &cached.latest) {
                        Some(cached.latest)
                    } else {
                        None
                    };
                }
            }
        }
    }

    // Fresh check
    let check = check_for_update().await.ok()?;

    // Write cache
    if let Ok(path) = cache_path() {
        let cached = CachedCheck {
            latest: check.latest.clone(),
            checked_at: now_secs(),
        };
        let _ = fs::write(&path, serde_json::to_string(&cached).unwrap_or_default());
    }

    if check.update_available {
        Some(check.latest)
    } else {
        None
    }
}

/// Download and install the latest release, replacing the current binary.
///
/// 1. Fetch latest version tag from fluidstate.ai
/// 2. Download platform-specific binary
/// 3. Download & verify SHA-256 checksum
/// 4. Atomic-swap into the current binary's location
pub async fn perform_update() -> Result<String> {
    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(std::time::Duration::from_secs(120))
        .build()?;

    println!("Checking for updates...");
    let release: LatestRelease = client
        .get(format!("{SITE}/api/releases/latest"))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;

    let tag = &release.tag_name;
    let latest = normalize_tag(tag).to_string();
    if !is_newer(VERSION, &latest) {
        println!("Already up to date ({VERSION}).");
        return Ok(VERSION.to_string());
    }

    let wanted = asset_name()?;
    debug!("looking for asset: {wanted}");

    // Parse checksum file if present
    let checksums_url = format!("{SITE}/api/releases/download/{tag}/checksums.sha256");
    let expected_checksum = match client.get(&checksums_url).send().await {
        Ok(resp) if resp.status().is_success() => {
            let body = resp.text().await?;
            parse_checksum(&body, &wanted)
        }
        _ => {
            warn!("no checksums.sha256 in release — skipping verification");
            None
        }
    };

    let binary_url = format!("{SITE}/api/releases/download/{tag}/{wanted}");
    println!("Downloading {wanted} (v{latest})...");
    let bytes = client
        .get(&binary_url)
        .send()
        .await?
        .error_for_status()?
        .bytes()
        .await?;

    // Verify checksum
    if let Some(expected) = &expected_checksum {
        let mut hasher = Sha256::new();
        hasher.update(&bytes);
        let actual = format!("{:x}", hasher.finalize());
        if actual != *expected {
            bail!(
                "checksum mismatch!\n  expected: {expected}\n  got:      {actual}\n\nDownload may be corrupted. Try again."
            );
        }
        println!("Checksum verified.");
    }

    // Write to temp file next to current binary, then atomic rename
    let current_exe = env::current_exe().context("cannot determine current executable path")?;
    let current_dir = current_exe
        .parent()
        .context("executable has no parent dir")?;

    let mut tmp =
        NamedTempFile::new_in(current_dir).context("failed to create temp file for update")?;
    tmp.write_all(&bytes)?;
    tmp.flush()?;

    // Set executable permission on unix
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = fs::Permissions::from_mode(0o755);
        fs::set_permissions(tmp.path(), perms)?;
    }

    // Replace the binary
    replace_binary(tmp.path(), &current_exe)?;

    // Update cache
    if let Ok(path) = cache_path() {
        let cached = CachedCheck {
            latest: latest.clone(),
            checked_at: now_secs(),
        };
        let _ = fs::write(&path, serde_json::to_string(&cached).unwrap_or_default());
    }

    println!("Updated FluidState: {VERSION} → {latest}");
    Ok(latest)
}

/// Parse a `checksums.sha256` file for a specific filename.
/// Expected format: `<hex>  <filename>` or `<hex> <filename>` per line.
fn parse_checksum(body: &str, filename: &str) -> Option<String> {
    for line in body.lines() {
        let parts: Vec<&str> = line.splitn(2, |c: char| c.is_whitespace()).collect();
        if parts.len() == 2 && parts[1].trim() == filename {
            return Some(parts[0].to_lowercase());
        }
    }
    None
}

/// Replace the running binary.
///
/// On macOS/Linux: rename old binary to `.old`, rename new to target, remove `.old`.
/// On Windows: rename old to `.old.exe`, move new in place (Windows allows this
/// while the process is running since it locks by handle, not path).
fn replace_binary(new_path: &Path, target: &Path) -> Result<()> {
    let backup = target.with_extension("old");

    // Remove stale backup from a previous update
    let _ = fs::remove_file(&backup);

    // Move current binary out of the way
    fs::rename(target, &backup)
        .with_context(|| format!("failed to move current binary to {}", backup.display()))?;

    // Move new binary into place
    if let Err(e) = fs::rename(new_path, target) {
        // Rollback: restore the backup
        let _ = fs::rename(&backup, target);
        return Err(e).context("failed to install new binary");
    }

    // Clean up backup
    let _ = fs::remove_file(&backup);

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_newer() {
        assert!(is_newer("0.6.0", "0.7.0"));
        assert!(is_newer("0.6.0", "1.0.0"));
        assert!(is_newer("0.6.0", "0.6.1"));
        assert!(!is_newer("0.7.0", "0.6.0"));
        assert!(!is_newer("0.6.0", "0.6.0"));
    }

    #[test]
    fn test_normalize_tag() {
        assert_eq!(normalize_tag("v0.7.0"), "0.7.0");
        assert_eq!(normalize_tag("0.7.0"), "0.7.0");
    }

    #[test]
    fn test_parse_checksum() {
        let body = "abc123  fluidstate-darwin-aarch64\ndef456  fluidstate-linux-x86_64\n";
        assert_eq!(
            parse_checksum(body, "fluidstate-darwin-aarch64"),
            Some("abc123".to_string())
        );
        assert_eq!(
            parse_checksum(body, "fluidstate-linux-x86_64"),
            Some("def456".to_string())
        );
        assert_eq!(parse_checksum(body, "fluidstate-windows-x86_64.exe"), None);
    }
}
