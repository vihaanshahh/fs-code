/// File system and git operations.
use std::path::{Path, PathBuf};
use tokio::fs;
use tokio::process::Command;

// ---------------------------------------------------------------------------
// Language detection
// ---------------------------------------------------------------------------

fn detect_language(path: &str) -> &'static str {
    let p = Path::new(path);
    match p.extension().and_then(|e| e.to_str()) {
        Some("ts") => "typescript",
        Some("tsx") => "typescriptreact",
        Some("js") => "javascript",
        Some("jsx") => "javascriptreact",
        Some("json") => "json",
        Some("md") | Some("mdx") => "markdown",
        Some("css") => "css",
        Some("html") | Some("htm") => "html",
        Some("py") => "python",
        Some("rs") => "rust",
        Some("go") => "go",
        Some("sh") | Some("bash") | Some("zsh") => "shell",
        Some("yml") | Some("yaml") => "yaml",
        Some("toml") => "toml",
        Some("sql") => "sql",
        Some("c") => "c",
        Some("cpp") | Some("cc") | Some("cxx") => "cpp",
        Some("h") | Some("hpp") => "cpp",
        Some("java") => "java",
        Some("rb") => "ruby",
        Some("php") => "php",
        Some("swift") => "swift",
        Some("kt") | Some("kts") => "kotlin",
        Some("xml") => "xml",
        Some("svg") => "xml",
        _ => "plaintext",
    }
}

// ---------------------------------------------------------------------------
// Directory listing — recursive FileEntry tree
// ---------------------------------------------------------------------------

const SKIP_DIRS: &[&str] = &[
    "node_modules", ".git", "dist", ".next", ".cache",
    "__pycache__", ".turbo", "out", ".DS_Store",
];

fn should_skip(name: &str, depth: u32) -> bool {
    if SKIP_DIRS.contains(&name) {
        return true;
    }
    // Skip hidden files/dirs at depth > 0
    if depth > 0 && name.starts_with('.') {
        return true;
    }
    false
}

fn read_dir_recursive(root: &Path, dir: &Path, depth: u32, max_depth: u32) -> Vec<serde_json::Value> {
    let mut entries = Vec::new();

    let read = match std::fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return entries,
    };

    let mut items: Vec<std::fs::DirEntry> = read.flatten().collect();
    items.sort_by(|a, b| {
        let a_is_dir = a.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let b_is_dir = b.file_type().map(|t| t.is_dir()).unwrap_or(false);
        b_is_dir.cmp(&a_is_dir)
            .then(a.file_name().to_string_lossy().to_lowercase()
                .cmp(&b.file_name().to_string_lossy().to_lowercase()))
    });

    for item in items {
        let name = item.file_name().to_string_lossy().to_string();
        if should_skip(&name, depth) {
            continue;
        }

        let file_type = match item.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };

        let abs_path = item.path();
        // relative path from root
        let rel_path = abs_path.strip_prefix(root)
            .unwrap_or(&abs_path)
            .to_string_lossy()
            .to_string();

        if file_type.is_dir() {
            let children = if depth < max_depth {
                read_dir_recursive(root, &abs_path, depth + 1, max_depth)
            } else {
                vec![]
            };
            entries.push(serde_json::json!({
                "name": name,
                "path": rel_path,
                "type": "directory",
                "children": children,
            }));
        } else {
            entries.push(serde_json::json!({
                "name": name,
                "path": rel_path,
                "type": "file",
            }));
        }
    }

    entries
}

pub async fn read_directory(path: &str) -> Result<serde_json::Value, String> {
    let root = PathBuf::from(path);
    if !root.exists() {
        return Err(format!("Directory not found: {path}"));
    }
    let entries = read_dir_recursive(&root, &root, 0, 4);
    Ok(serde_json::json!(entries))
}

// ---------------------------------------------------------------------------
// File read/write
// ---------------------------------------------------------------------------

pub async fn read_file(path: &str) -> Result<serde_json::Value, String> {
    let content = fs::read_to_string(path).await.map_err(|e| e.to_string())?;
    let language = detect_language(path);
    Ok(serde_json::json!({
        "content": content,
        "language": language,
    }))
}

pub async fn write_file(path: &str, content: &str) -> Result<(), String> {
    if let Some(parent) = Path::new(path).parent() {
        fs::create_dir_all(parent).await.map_err(|e| e.to_string())?;
    }
    fs::write(path, content).await.map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

async fn git(cwd: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()
        .await
        .map_err(|e| e.to_string())?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

// ---------------------------------------------------------------------------
// git_status — returns absolute paths and clean status strings
// ---------------------------------------------------------------------------

pub async fn git_status(cwd: &str) -> Result<serde_json::Value, String> {
    // Get repo root for absolute paths
    let repo_root = git(cwd, &["rev-parse", "--show-toplevel"])
        .await
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|_| cwd.to_string());

    let raw = git(cwd, &["status", "--porcelain", "-z"]).await?;
    let mut files = Vec::new();

    for entry in raw.split('\0').filter(|s| s.len() > 3) {
        let xy = &entry[..2];
        let rel_path = entry[3..].to_string();

        // Handle renames: "R old -> new" — take the new name after " -> "
        let rel_path = if let Some(idx) = rel_path.find(" -> ") {
            rel_path[idx + 4..].to_string()
        } else {
            rel_path
        };

        let abs_path = PathBuf::from(&repo_root).join(&rel_path)
            .to_string_lossy()
            .to_string();

        let status = map_porcelain_status(xy);

        files.push(serde_json::json!({
            "path": abs_path,
            "status": status,
        }));
    }

    Ok(serde_json::json!({ "files": files }))
}

fn map_porcelain_status(xy: &str) -> &'static str {
    let x = &xy[..1];
    let y = &xy[1..];
    if xy == "??" {
        return "untracked";
    }
    if x == "D" || y == "D" {
        return "deleted";
    }
    if x == "A" {
        return "added";
    }
    if x == "M" || y == "M" || x == "U" || y == "U" {
        return "modified";
    }
    "modified"
}

// ---------------------------------------------------------------------------
// git_status_detailed
// ---------------------------------------------------------------------------

pub async fn git_status_detailed(cwd: &str) -> Result<serde_json::Value, String> {
    let repo_root = git(cwd, &["rev-parse", "--show-toplevel"])
        .await
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|_| cwd.to_string());

    let raw = git(cwd, &["status", "--porcelain=v1", "-z"]).await?;
    let mut files = Vec::new();

    for entry in raw.split('\0').filter(|s| s.len() > 3) {
        let xy = &entry[..2];
        let rel_path_raw = entry[3..].to_string();

        // Handle renames: split on " -> " and take the destination
        let rel_path = if let Some(idx) = rel_path_raw.find(" -> ") {
            rel_path_raw[idx + 4..].to_string()
        } else {
            rel_path_raw
        };

        let abs_path = PathBuf::from(&repo_root).join(&rel_path)
            .to_string_lossy()
            .to_string();

        let basename = Path::new(&rel_path)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| rel_path.clone());

        let index_status = xy.chars().next().unwrap_or(' ');
        let work_tree_status = xy.chars().nth(1).unwrap_or(' ');

        let category = if xy == "??" {
            "untracked"
        } else if index_status != ' ' {
            "staged"
        } else {
            "unstaged"
        };

        files.push(serde_json::json!({
            "path": abs_path,
            "basename": basename,
            "indexStatus": index_status.to_string(),
            "workTreeStatus": work_tree_status.to_string(),
            "category": category,
        }));
    }

    Ok(serde_json::json!({ "files": files }))
}

// ---------------------------------------------------------------------------
// git_diff — structured object matching Electron's getGitDiff
// ---------------------------------------------------------------------------

pub async fn git_diff(file_path: &str, cwd: Option<&str>) -> Result<serde_json::Value, String> {
    // 1. Read current file content
    let current_content = match fs::read_to_string(file_path).await {
        Ok(c) => c,
        Err(_) => {
            return Ok(serde_json::json!({
                "baseContent": null,
                "currentContent": "",
                "status": "error",
            }));
        }
    };

    // 2. Determine the working directory for git commands
    let work_dir = if let Some(c) = cwd {
        c.to_string()
    } else {
        Path::new(file_path)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| ".".to_string())
    };

    // 3. Find repo root
    let repo_root = match git(&work_dir, &["rev-parse", "--show-toplevel"]).await {
        Ok(root) => root.trim().to_string(),
        Err(_) => {
            return Ok(serde_json::json!({
                "baseContent": current_content,
                "currentContent": current_content,
                "status": "untracked",
            }));
        }
    };

    // 4. Compute relative path from repo root
    let abs_file = Path::new(file_path);
    let rel_path = abs_file
        .strip_prefix(&repo_root)
        .unwrap_or(abs_file)
        .to_string_lossy()
        .to_string();

    // 5. Check git status for this file
    let status_out = git(&repo_root, &["status", "--porcelain", "--", &rel_path])
        .await
        .unwrap_or_default();
    let status_out = status_out.trim();

    if status_out.is_empty() {
        // File is tracked and unchanged
        return Ok(serde_json::json!({
            "baseContent": current_content,
            "currentContent": current_content,
            "status": "unchanged",
        }));
    }

    let xy = if status_out.len() >= 2 { &status_out[..2] } else { "  " };
    let x = &xy[..1];
    let y = if xy.len() > 1 { &xy[1..2] } else { " " };

    if xy == "??" {
        return Ok(serde_json::json!({
            "baseContent": null,
            "currentContent": current_content,
            "status": "untracked",
        }));
    }

    if x == "A" {
        return Ok(serde_json::json!({
            "baseContent": null,
            "currentContent": current_content,
            "status": "added",
        }));
    }

    if x == "D" || y == "D" {
        // Deleted — get base content from HEAD
        let base_content = git(&repo_root, &["show", &format!("HEAD:{rel_path}")])
            .await
            .unwrap_or_default();
        return Ok(serde_json::json!({
            "baseContent": base_content,
            "currentContent": "",
            "status": "deleted",
        }));
    }

    // Modified — get base content from HEAD
    let base_content = git(&repo_root, &["show", &format!("HEAD:{rel_path}")])
        .await
        .ok();

    Ok(serde_json::json!({
        "baseContent": base_content,
        "currentContent": current_content,
        "status": "modified",
    }))
}

// ---------------------------------------------------------------------------
// git_stage / git_unstage / git_discard / git_commit
// ---------------------------------------------------------------------------

pub async fn git_stage(path: &str, cwd: &str) -> Result<serde_json::Value, String> {
    match git(cwd, &["add", "--", path]).await {
        Ok(_) => Ok(serde_json::json!({ "success": true })),
        Err(e) => Ok(serde_json::json!({ "success": false, "error": e })),
    }
}

pub async fn git_unstage(path: &str, cwd: &str) -> Result<serde_json::Value, String> {
    match git(cwd, &["restore", "--staged", "--", path]).await {
        Ok(_) => Ok(serde_json::json!({ "success": true })),
        Err(e) => Ok(serde_json::json!({ "success": false, "error": e })),
    }
}

pub async fn git_discard(path: &str, cwd: &str) -> Result<serde_json::Value, String> {
    // Check if file is untracked (??), if so remove it instead of restoring
    let status_out = git(cwd, &["status", "--porcelain", "--", path])
        .await
        .unwrap_or_default();
    let xy = status_out.trim();

    if xy.starts_with("??") {
        // Untracked — delete the file
        match std::fs::remove_file(path) {
            Ok(_) => return Ok(serde_json::json!({ "success": true })),
            Err(e) => return Ok(serde_json::json!({ "success": false, "error": e.to_string() })),
        }
    }

    match git(cwd, &["restore", "--", path]).await {
        Ok(_) => Ok(serde_json::json!({ "success": true })),
        Err(e) => Ok(serde_json::json!({ "success": false, "error": e })),
    }
}

pub async fn git_commit(message: &str, cwd: &str) -> Result<serde_json::Value, String> {
    match git(cwd, &["commit", "-m", message]).await {
        Ok(output) => {
            // Parse hash from output like "[branch abc1234]" or "[branch abc1234 (root-commit)]"
            let hash = extract_commit_hash(&output);
            let mut result = serde_json::json!({ "success": true });
            if let Some(h) = hash {
                result["hash"] = serde_json::Value::String(h);
            }
            Ok(result)
        }
        Err(e) => Ok(serde_json::json!({ "success": false, "error": e })),
    }
}

fn extract_commit_hash(output: &str) -> Option<String> {
    // Look for pattern: [branch-name abc1234] or [branch abc1234 ...]
    for line in output.lines() {
        if line.starts_with('[') {
            // Split on whitespace; hash is typically the 2nd or 3rd token
            // Pattern: [branch hash message...] or [branch (root-commit) hash ...]
            let inner = line.trim_start_matches('[');
            if let Some(end) = inner.find(']') {
                let tokens: Vec<&str> = inner[..end].split_whitespace().collect();
                // Find the token that looks like a git hash (7-40 hex chars)
                for token in &tokens[1..] {
                    let t = token.trim_end_matches(')').trim_start_matches('(');
                    if t.len() >= 7 && t.chars().all(|c| c.is_ascii_hexdigit()) {
                        return Some(t.to_string());
                    }
                }
            }
        }
    }
    None
}

// ---------------------------------------------------------------------------
// File search (for @ mention autocomplete)
// ---------------------------------------------------------------------------

pub async fn search_files(cwd: &str, query: &str, limit: Option<usize>) -> Vec<String> {
    let limit = limit.unwrap_or(50);
    let query_lower = query.to_lowercase();

    let git_files = Command::new("git")
        .args(["ls-files", "--cached", "--others", "--exclude-standard"])
        .current_dir(cwd)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .output()
        .await;

    if let Ok(output) = git_files {
        let all: Vec<String> = String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter(|l| l.to_lowercase().contains(&query_lower))
            .take(limit)
            .map(|s| s.to_string())
            .collect();
        return all;
    }

    // Fallback: walkdir
    let cwd_path = std::path::PathBuf::from(cwd);
    let mut results = Vec::new();
    for entry in walkdir::WalkDir::new(&cwd_path)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| !is_hidden(e))
        .flatten()
    {
        if entry.file_type().is_file() {
            let rel = entry
                .path()
                .strip_prefix(&cwd_path)
                .unwrap_or(entry.path())
                .to_string_lossy()
                .to_string();
            if rel.to_lowercase().contains(&query_lower) {
                results.push(rel);
                if results.len() >= limit {
                    break;
                }
            }
        }
    }
    results
}

fn is_hidden(entry: &walkdir::DirEntry) -> bool {
    entry
        .file_name()
        .to_str()
        .map(|s| s.starts_with('.'))
        .unwrap_or(false)
        || entry
            .path()
            .to_str()
            .map(|s| s.contains("node_modules") || s.contains("target/"))
            .unwrap_or(false)
}
