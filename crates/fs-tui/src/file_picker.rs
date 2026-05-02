//! File picker — fuzzy search overlay for browsing and opening files.
//!
//! Triggered by Ctrl+O (open file) or Ctrl+D (diff file).
//! Lists files from the current directory (respects common ignores),
//! with fuzzy filtering as you type.

use std::path::Path;

use ratatui::prelude::*;
use ratatui::widgets::{Block, Borders, Clear, List, ListItem, Paragraph};

use crate::theme::Theme;

// ---------------------------------------------------------------------------
// Ignore patterns
// ---------------------------------------------------------------------------

const IGNORE_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    "target",
    "dist",
    ".next",
    ".cache",
    "__pycache__",
    ".turbo",
    "out",
];

const IGNORE_EXTS: &[&str] = &[
    "woff", "woff2", "ttf", "eot",
    "lock", "pyc", "o", "so", "dylib",
];

// ---------------------------------------------------------------------------
// File picker state
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum PickerMode {
    Open,   // Open file in editor
    Diff,   // Show git diff for file
}

pub struct FilePicker {
    open: bool,
    pub mode: PickerMode,
    input: String,
    files: Vec<String>,
    /// Git status char per file ('M', 'A', 'D', '?', or ' ').
    /// Only populated in Diff mode; used to pick the display color.
    file_statuses: Vec<char>,
    filtered: Vec<usize>, // indices into files
    selected: usize,
    scroll: usize,
    cwd: String,
}

impl FilePicker {
    pub fn new() -> Self {
        Self {
            open: false,
            mode: PickerMode::Open,
            input: String::new(),
            files: Vec::new(),
            file_statuses: Vec::new(),
            filtered: Vec::new(),
            selected: 0,
            scroll: 0,
            cwd: String::new(),
        }
    }


    pub fn open(&mut self, cwd: &str, mode: PickerMode) {
        self.cwd = cwd.to_string();
        self.mode = mode;
        self.input.clear();
        self.selected = 0;
        self.scroll = 0;
        match mode {
            PickerMode::Diff => {
                let (files, statuses) = collect_git_files(cwd);
                self.files = files;
                self.file_statuses = statuses;
            }
            PickerMode::Open => {
                self.files = collect_files(cwd, 3);
                self.file_statuses = vec![' '; self.files.len()];
            }
        }
        self.refilter();
        self.open = true;
    }

    pub fn close(&mut self) {
        self.open = false;
    }

    pub fn input(&mut self, c: char) {
        self.input.push(c);
        self.refilter();
        self.selected = 0;
        self.scroll = 0;
    }

    pub fn backspace(&mut self) {
        self.input.pop();
        self.refilter();
        self.selected = 0;
        self.scroll = 0;
    }

    pub fn move_selection(&mut self, delta: i32) {
        if self.filtered.is_empty() {
            return;
        }
        let new = self.selected as i32 + delta;
        self.selected = new.clamp(0, self.filtered.len() as i32 - 1) as usize;
    }

    pub fn move_first(&mut self) {
        self.selected = 0;
    }

    pub fn move_last(&mut self) {
        if !self.filtered.is_empty() {
            self.selected = self.filtered.len() - 1;
        }
    }

    /// Select the item at the given visual row (relative to list start).
    pub fn click_row(&mut self, row: usize) {
        let new_idx = self.scroll + row;
        if new_idx < self.filtered.len() {
            self.selected = new_idx;
        }
    }

    /// Scroll the visible result window by delta lines (negative = up).
    pub fn scroll_by(&mut self, delta: i32, visible_height: usize) {
        if self.filtered.is_empty() || visible_height == 0 {
            return;
        }
        if delta < 0 {
            self.scroll = self.scroll.saturating_sub((-delta) as usize);
        } else {
            let max = self.filtered.len().saturating_sub(visible_height);
            self.scroll = (self.scroll + delta as usize).min(max);
        }
        self.keep_selection_in_scroll_window(visible_height);
    }

    /// Execute selection — returns (full_path, mode).
    pub fn execute(&mut self) -> Option<(String, PickerMode)> {
        let idx = self.filtered.get(self.selected).copied()?;
        let rel_path = self.files.get(idx)?;
        let full_path = if Path::new(rel_path).is_absolute() {
            rel_path.clone()
        } else {
            format!("{}/{}", self.cwd, rel_path)
        };
        let mode = self.mode;
        self.close();
        Some((full_path, mode))
    }

    fn refilter(&mut self) {
        let query = self.input.to_lowercase();
        self.filtered = self
            .files
            .iter()
            .enumerate()
            .filter(|(_, f)| query.is_empty() || fuzzy_match(&f.to_lowercase(), &query))
            .map(|(i, _)| i)
            .collect();
    }

    pub fn render(&mut self, frame: &mut Frame, area: Rect, theme: &Theme) {
        let w = 60u16.min(area.width.saturating_sub(4));
        let h = 20u16.min(area.height.saturating_sub(4));
        let x = area.x + (area.width.saturating_sub(w)) / 2;
        let y = area.y + 2;

        let picker_area = Rect::new(x, y, w, h);
        frame.render_widget(Clear, picker_area);

        let mode_label = match self.mode {
            PickerMode::Open => "Open File",
            PickerMode::Diff => "View Diff",
        };

        let block = Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(theme.text))
            .title(Span::styled(
                format!(" {} ", mode_label),
                Style::default().fg(theme.text).add_modifier(Modifier::BOLD),
            ));

        let inner = block.inner(picker_area);
        frame.render_widget(block, picker_area);

        if inner.height < 2 {
            return;
        }

        // Search input
        let input_area = Rect::new(inner.x, inner.y, inner.width, 1);
        let count = self.filtered.len();
        let total = self.files.len();
        let prompt = format!("❯ {}  ({}/{})", self.input, count, total);
        frame.render_widget(
            Paragraph::new(prompt).style(Style::default().fg(theme.text)),
            input_area,
        );

        // File list
        let list_area = Rect::new(inner.x, inner.y + 1, inner.width, inner.height - 1);
        let max_items = list_area.height as usize;
        self.keep_selected_visible(max_items);

        let items: Vec<ListItem> = self
            .filtered
            .iter()
            .skip(self.scroll)
            .take(max_items)
            .enumerate()
            .map(|(i, &file_idx)| {
                let path = &self.files[file_idx];
                let is_selected = self.scroll + i == self.selected;

                let (prefix, style) = if is_selected {
                    ("▸ ", Style::default().fg(theme.text).add_modifier(Modifier::BOLD | Modifier::REVERSED))
                } else {
                    let status = self.file_statuses.get(file_idx).copied().unwrap_or(' ');
                    let fg = match status {
                        'M' | 'm' => theme.amber,
                        'A' | 'a' => theme.green,
                        'D' | 'd' => theme.red,
                        '?' => theme.text_muted,
                        _ => theme.text,
                    };
                    ("  ", Style::default().fg(fg))
                };

                // In diff mode, show the status char as a prefix badge
                let label = if self.mode == PickerMode::Diff {
                    let status = self.file_statuses.get(file_idx).copied().unwrap_or(' ');
                    format!("{} {}", status, path)
                } else {
                    path.clone()
                };

                ListItem::new(Line::from(vec![
                    Span::styled(prefix, style),
                    Span::styled(label, style),
                ]))
            })
            .collect();

        frame.render_widget(List::new(items), list_area);
    }

    fn keep_selected_visible(&mut self, visible_height: usize) {
        if visible_height == 0 || self.filtered.is_empty() {
            self.scroll = 0;
            return;
        }
        if self.selected >= self.filtered.len() {
            self.selected = self.filtered.len() - 1;
        }
        if self.selected < self.scroll {
            self.scroll = self.selected;
        } else if self.selected >= self.scroll + visible_height {
            self.scroll = self.selected - visible_height + 1;
        }
        let max_scroll = self.filtered.len().saturating_sub(visible_height);
        self.scroll = self.scroll.min(max_scroll);
    }

    fn keep_selection_in_scroll_window(&mut self, visible_height: usize) {
        if visible_height == 0 || self.filtered.is_empty() {
            return;
        }
        let last_visible = self.scroll + visible_height.saturating_sub(1);
        if self.selected < self.scroll {
            self.selected = self.scroll.min(self.filtered.len() - 1);
        } else if self.selected > last_visible {
            self.selected = last_visible.min(self.filtered.len() - 1);
        }
    }
}

// ---------------------------------------------------------------------------
// Git-changed file collection — for Diff mode
// ---------------------------------------------------------------------------

/// Returns (paths, status_chars) from `git status --porcelain`.
/// Status chars: 'M' modified, 'A' added, 'D' deleted, '?' untracked.
fn collect_git_files(cwd: &str) -> (Vec<String>, Vec<char>) {
    let output = std::process::Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(cwd)
        .output();

    if let Ok(out) = output {
        parse_git_status(&String::from_utf8_lossy(&out.stdout))
    } else {
        (Vec::new(), Vec::new())
    }
}

/// Parse the text output of `git status --porcelain` into (paths, status_chars).
fn parse_git_status(porcelain: &str) -> (Vec<String>, Vec<char>) {
    let mut files = Vec::new();
    let mut statuses = Vec::new();

    for line in porcelain.lines() {
        if line.len() < 4 {
            continue;
        }
        let xy = line.as_bytes();
        // XY format: index status (xy[0]) + worktree status (xy[1])
        let x = xy[0] as char;
        let y = xy[1] as char;
        let path_part = &line[3..];

        // For renames "old -> new", take the new path
        let path = if path_part.contains(" -> ") {
            path_part.split(" -> ").nth(1).unwrap_or(path_part).trim_matches('"').to_string()
        } else {
            path_part.trim_matches('"').to_string()
        };

        // Resolve status: prefer index, fall back to worktree
        let status = match (x, y) {
            ('?', '?') => '?',
            ('D', _) | (_, 'D') => 'D',
            ('A', _) | (_, 'A') => 'A',
            ('R', _) | (_, 'R') => 'M', // treat rename as modified
            ('M', _) | (_, 'M') => 'M',
            _ => 'M',
        };

        files.push(path);
        statuses.push(status);
    }

    (files, statuses)
}

// ---------------------------------------------------------------------------
// File collection — walk directory respecting ignores
// ---------------------------------------------------------------------------

fn collect_files(root: &str, max_depth: usize) -> Vec<String> {
    let mut files = Vec::new();
    walk_dir(Path::new(root), Path::new(root), 0, max_depth, &mut files);
    files.sort();
    files
}

fn walk_dir(root: &Path, dir: &Path, depth: usize, max_depth: usize, out: &mut Vec<String>) {
    if depth > max_depth {
        return;
    }

    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();

        // Skip hidden files/dirs (except at root)
        if depth > 0 && name.starts_with('.') {
            continue;
        }

        // Skip ignored directories
        if IGNORE_DIRS.contains(&name.as_str()) {
            continue;
        }

        let path = entry.path();
        if path.is_dir() {
            walk_dir(root, &path, depth + 1, max_depth, out);
        } else {
            // Skip ignored extensions
            if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                if IGNORE_EXTS.contains(&ext) {
                    continue;
                }
            }

            if let Ok(rel) = path.strip_prefix(root) {
                out.push(rel.to_string_lossy().to_string());
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Fuzzy matching
// ---------------------------------------------------------------------------

fn fuzzy_match(haystack: &str, needle: &str) -> bool {
    let mut needle_chars = needle.chars().peekable();
    for h in haystack.chars() {
        if let Some(&n) = needle_chars.peek() {
            if h == n {
                needle_chars.next();
            }
        }
        if needle_chars.peek().is_none() {
            return true;
        }
    }
    needle_chars.peek().is_none()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fuzzy_basic() {
        assert!(fuzzy_match("src/main.rs", "main"));
        assert!(fuzzy_match("src/main.rs", "smr"));
        assert!(fuzzy_match("src/main.rs", "src/main.rs"));
        assert!(!fuzzy_match("src/main.rs", "xyz"));
    }

    #[test]
    fn git_status_modified() {
        let input = " M crates/fs-tui/src/app.rs\n";
        let (files, statuses) = parse_git_status(input);
        assert_eq!(files, vec!["crates/fs-tui/src/app.rs"]);
        assert_eq!(statuses, vec!['M']);
    }

    #[test]
    fn git_status_staged_modified() {
        let input = "M  crates/fs-tui/src/app.rs\n";
        let (_files, statuses) = parse_git_status(input);
        assert_eq!(statuses, vec!['M']);
    }

    #[test]
    fn git_status_added() {
        let input = "A  new_file.rs\n";
        let (files, statuses) = parse_git_status(input);
        assert_eq!(files, vec!["new_file.rs"]);
        assert_eq!(statuses, vec!['A']);
    }

    #[test]
    fn git_status_deleted() {
        let input = "D  old_file.rs\n";
        let (_files, statuses) = parse_git_status(input);
        assert_eq!(statuses, vec!['D']);
    }

    #[test]
    fn git_status_untracked() {
        let input = "?? untracked.rs\n";
        let (files, statuses) = parse_git_status(input);
        assert_eq!(files, vec!["untracked.rs"]);
        assert_eq!(statuses, vec!['?']);
    }

    #[test]
    fn git_status_rename() {
        let input = "R  old.rs -> new.rs\n";
        let (files, statuses) = parse_git_status(input);
        assert_eq!(files, vec!["new.rs"]);
        assert_eq!(statuses, vec!['M']);
    }

    #[test]
    fn git_status_mixed() {
        let input = " M src/app.rs\nA  src/new.rs\nD  src/old.rs\n?? scratch.rs\n";
        let (files, statuses) = parse_git_status(input);
        assert_eq!(files, vec!["src/app.rs", "src/new.rs", "src/old.rs", "scratch.rs"]);
        assert_eq!(statuses, vec!['M', 'A', 'D', '?']);
    }

    #[test]
    fn git_status_empty() {
        let (files, statuses) = parse_git_status("");
        assert!(files.is_empty());
        assert!(statuses.is_empty());
    }

    #[test]
    fn refilter_keeps_matches_past_first_hundred() {
        let mut picker = FilePicker::new();
        picker.files = (0..150).map(|i| format!("src/file-{}.rs", i)).collect();
        picker.file_statuses = vec![' '; picker.files.len()];

        picker.refilter();

        assert_eq!(picker.filtered.len(), 150);
    }

    #[test]
    fn scroll_by_reaches_later_results_and_click_uses_scroll_offset() {
        let mut picker = FilePicker::new();
        picker.files = (0..150).map(|i| format!("src/file-{}.rs", i)).collect();
        picker.file_statuses = vec![' '; picker.files.len()];
        picker.refilter();

        picker.scroll_by(1_000, 10);

        assert_eq!(picker.scroll, 140);
        assert_eq!(picker.selected, 140);

        picker.click_row(9);

        assert_eq!(picker.selected, 149);
    }

    #[test]
    fn collect_files_includes_images_for_external_opening() {
        let root = std::env::temp_dir().join(format!(
            "fs-code-file-picker-test-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("photo.png"), b"not a real image").unwrap();

        let files = collect_files(root.to_str().unwrap(), 1);

        let _ = std::fs::remove_dir_all(&root);
        assert!(files.contains(&"photo.png".to_string()));
    }
}
