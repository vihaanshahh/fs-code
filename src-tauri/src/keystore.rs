/// Secure credential storage via OS keychain (keyring crate).
///
/// Maps the Electron safeStorage API to keyring:
///   service = "FluidState"
///   username = key name (e.g. "api_key:openai", "gh_token")
use keyring::Entry;

const SERVICE: &str = "FluidState";

fn entry(name: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, name).map_err(|e| e.to_string())
}

pub fn set_secret(name: &str, value: &str) -> Result<(), String> {
    entry(name)?.set_password(value).map_err(|e| e.to_string())
}

pub fn get_secret(name: &str) -> Result<Option<String>, String> {
    match entry(name)?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

pub fn has_secret(name: &str) -> Result<bool, String> {
    match entry(name)?.get_password() {
        Ok(_) => Ok(true),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(e) => Err(e.to_string()),
    }
}

pub fn remove_secret(name: &str) -> Result<(), String> {
    match entry(name)?.delete_password() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()), // already gone
        Err(e) => Err(e.to_string()),
    }
}

// Convenience wrappers matching the Electron API surface
pub fn set_provider_api_key(provider: &str, key: &str) -> Result<(), String> {
    set_secret(&format!("api_key:{provider}"), key)
}

pub fn has_provider_api_key(provider: &str) -> Result<bool, String> {
    has_secret(&format!("api_key:{provider}"))
}

pub fn set_github_token(token: &str) -> Result<(), String> {
    set_secret("gh_token", token)
}

pub fn has_github_token() -> Result<bool, String> {
    has_secret("gh_token")
}

pub fn remove_github_token() -> Result<(), String> {
    remove_secret("gh_token")
}
