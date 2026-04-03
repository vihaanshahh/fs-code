//! File picker — fuzzy search overlay for browsing and opening files.
//!
//! Triggered by Ctrl+O (open file) or Ctrl+D (diff file).
//! Lists files from the current directory (respects common ignores),
//! with fuzzy filtering as you type.

use std::path::Path;

use ratatui::prelude::*;
use ratatui::widgets::{Block, Borders, Clear, List, ListItem, Paragraph};

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
    "png", "jpg", "jpeg", "gif", "ico", "svg",
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
    filtered: Vec<usize>, // indices into files
    selected: usize,
    cwd: String,
}

impl FilePicker {
    pub fn new() -> Self {
        Self {
            open: false,
            mode: PickerMode::Open,
            input: String::new(),
            files: Vec::new(),
            filtered: Vec::new(),
            selected: 0,
            cwd: String::new(),
        }
    }

    pub fn is_open(&self) -> bool {
        self.open
    }

    pub fn open(&mut self, cwd: &str, mode: PickerMode) {
        self.cwd = cwd.to_string();
        self.mode = mode;
        self.input.clear();
        self.selected = 0;
        self.files = collect_files(cwd, 3); // max depth 3
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
    }

    pub fn backspace(&mut self) {
        self.input.pop();
        self.refilter();
        self.selected = 0;
    }

    pub fn move_selection(&mut self, delta: i32) {
        if self.filtered.is_empty() {
            return;
        }
        let new = self.selected as i32 + delta;
        self.selected = new.clamp(0, self.filtered.len() as i32 - 1) as usize;
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
            .take(100)
            .collect();
    }

    pub fn render(&self, frame: &mut Frame, area: Rect) {
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
            .border_style(Style::default().fg(Color::Magenta))
            .title(Span::styled(
                format!(" {} ", mode_label),
                Style::default()
                    .fg(Color::Magenta)
                    .add_modifier(Modifier::BOLD),
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
            Paragraph::new(prompt).style(Style::default().fg(Color::White)),
            input_area,
        );

        // File list
        let list_area = Rect::new(inner.x, inner.y + 1, inner.width, inner.height - 1);
        let max_items = list_area.height as usize;

        let items: Vec<ListItem> = self
            .filtered
            .iter()
            .take(max_items)
            .enumerate()
            .map(|(i, &file_idx)| {
                let path = &self.files[file_idx];
                let is_selected = i == self.selected;
                let style = if is_selected {
                    Style::default()
                        .fg(Color::Magenta)
                        .add_modifier(Modifier::BOLD)
                } else {
                    Style::default().fg(Color::White)
                };

                let prefix = if is_selected { "▸ " } else { "  " };
                ListItem::new(Line::from(vec![
                    Span::styled(prefix, style),
                    Span::styled(path.as_str(), style),
                ]))
            })
            .collect();

        frame.render_widget(List::new(items), list_area);
    }
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
}
