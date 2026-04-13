//! File tree sidebar — persistent left panel showing directory structure.
//!
//! Toggle with Ctrl+E. Navigate with j/k or arrows.
//! Enter/Space to expand dirs or open files in editor.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::fs;

use ratatui::prelude::*;
use ratatui::widgets::{Block, Borders, List, ListItem};

use crate::theme::Theme;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

pub const SIDEBAR_WIDTH: u16 = 30;

const IGNORE_DIRS: &[&str] = &[
    "node_modules", ".git", "target", "dist", ".next",
    ".cache", "__pycache__", ".turbo", "out",
];

// ---------------------------------------------------------------------------
// Inline input mode
// ---------------------------------------------------------------------------

/// What kind of inline input is active in the file tree.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum TreeInputMode {
    NewFile,
    NewFolder,
    Rename,
}

// ---------------------------------------------------------------------------
// Tree node
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct TreeNode {
    name: String,
    path: PathBuf,
    is_dir: bool,
    expanded: bool,
    depth: usize,
    git_status: char, // ' ', 'M', 'A', 'D', '?'
}

// ---------------------------------------------------------------------------
// FileTree
// ---------------------------------------------------------------------------

pub struct FileTree {
    nodes: Vec<TreeNode>,
    selected: usize,
    scroll: usize,
    cwd: String,
    /// Relative path → git status char, populated on load/refresh.
    git_statuses: HashMap<String, char>,
    /// Currently active inline input mode (new file, new folder, rename).
    input_mode: Option<TreeInputMode>,
    /// Text buffer for inline input.
    input_buf: String,
    /// The path of the item being renamed (for Rename mode).
    input_target: Option<PathBuf>,
    /// Index where a "move" operation started (source).
    move_source: Option<usize>,
}

impl FileTree {
    pub fn new() -> Self {
        Self {
            nodes: Vec::new(),
            selected: 0,
            scroll: 0,
            cwd: String::new(),
            git_statuses: HashMap::new(),
            input_mode: None,
            input_buf: String::new(),
            input_target: None,
            move_source: None,
        }
    }

    /// Load (or reload) the tree rooted at `cwd`.
    pub fn load(&mut self, cwd: &str) {
        self.cwd = cwd.to_string();
        self.git_statuses = load_git_statuses(cwd);
        self.nodes.clear();
        self.selected = 0;
        self.scroll = 0;
        self.append_dir_entries(Path::new(cwd), 0);
    }

    pub fn refresh(&mut self) {
        let cwd = self.cwd.clone();
        if !cwd.is_empty() {
            self.load(&cwd);
        }
    }

    // -----------------------------------------------------------------------
    // Navigation
    // -----------------------------------------------------------------------

    pub fn move_up(&mut self) {
        if self.selected > 0 {
            self.selected -= 1;
        }
    }

    pub fn move_down(&mut self) {
        if self.selected + 1 < self.nodes.len() {
            self.selected += 1;
        }
    }

    /// Returns the path of the currently highlighted node.
    pub fn selected_path(&self) -> Option<PathBuf> {
        self.nodes.get(self.selected).map(|n| n.path.clone())
    }

    /// Toggle expand/collapse on the selected node.
    /// Returns `Some(path)` if a *file* was activated (caller should open it).
    pub fn activate_selected(&mut self) -> Option<PathBuf> {
        let node = self.nodes.get(self.selected)?;
        if node.is_dir {
            if node.expanded {
                self.collapse(self.selected);
            } else {
                self.expand(self.selected);
            }
            None
        } else {
            Some(node.path.clone())
        }
    }

    // -----------------------------------------------------------------------
    // Expand / collapse
    // -----------------------------------------------------------------------

    fn expand(&mut self, idx: usize) {
        {
            let node = &mut self.nodes[idx];
            if !node.is_dir || node.expanded {
                return;
            }
            node.expanded = true;
        }

        let dir_path = self.nodes[idx].path.clone();
        let child_depth = self.nodes[idx].depth + 1;
        let insert_at = idx + 1;

        let mut new_nodes = Vec::new();
        self.collect_dir_entries(&dir_path, child_depth, &mut new_nodes);

        let tail = self.nodes.split_off(insert_at);
        self.nodes.extend(new_nodes);
        self.nodes.extend(tail);
    }

    fn collapse(&mut self, idx: usize) {
        {
            let node = &mut self.nodes[idx];
            if !node.is_dir || !node.expanded {
                return;
            }
            node.expanded = false;
        }

        let parent_depth = self.nodes[idx].depth;
        // Remove every node after `idx` whose depth is deeper than the parent.
        let end = self.nodes[idx + 1..]
            .iter()
            .position(|n| n.depth <= parent_depth)
            .map(|p| idx + 1 + p)
            .unwrap_or(self.nodes.len());

        self.nodes.drain(idx + 1..end);

        // If the cursor landed inside the removed range, pull it back.
        if self.selected > idx {
            self.selected = idx;
        }
    }

    // -----------------------------------------------------------------------
    // Directory reading helpers
    // -----------------------------------------------------------------------

    /// Append root-level entries of `dir` directly into `self.nodes`.
    fn append_dir_entries(&mut self, dir: &Path, depth: usize) {
        let mut tmp = Vec::new();
        self.collect_dir_entries(dir, depth, &mut tmp);
        self.nodes.extend(tmp);
    }

    fn collect_dir_entries(&self, dir: &Path, depth: usize, out: &mut Vec<TreeNode>) {
        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return,
        };

        let mut dirs: Vec<(String, PathBuf)> = Vec::new();
        let mut files: Vec<(String, PathBuf)> = Vec::new();

        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            // Skip hidden entries below root
            if depth > 0 && name.starts_with('.') {
                continue;
            }
            let path = entry.path();
            if path.is_dir() {
                if IGNORE_DIRS.contains(&name.as_str()) {
                    continue;
                }
                dirs.push((name, path));
            } else {
                files.push((name, path));
            }
        }

        dirs.sort_by(|a, b| a.0.cmp(&b.0));
        files.sort_by(|a, b| a.0.cmp(&b.0));

        for (name, path) in dirs.into_iter().chain(files.into_iter()) {
            let rel = path
                .strip_prefix(&self.cwd)
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default();
            let git_status = self.git_statuses.get(&rel).copied().unwrap_or(' ');
            let is_dir = path.is_dir();

            out.push(TreeNode {
                name,
                path,
                is_dir,
                expanded: false,
                depth,
                git_status,
            });
        }
    }

    // -----------------------------------------------------------------------
    // File system operations
    // -----------------------------------------------------------------------

    /// Determine the parent directory for a new file/folder operation.
    /// If the selected node is a directory, use it; otherwise use the parent of the selected file.
    fn selected_parent_dir(&self) -> Option<PathBuf> {
        let node = self.nodes.get(self.selected)?;
        if node.is_dir {
            Some(node.path.clone())
        } else {
            node.path.parent().map(|p| p.to_path_buf())
        }
    }

    /// Start creating a new file in the selected directory.
    pub fn start_new_file(&mut self) {
        if self.nodes.is_empty() {
            return;
        }
        self.input_mode = Some(TreeInputMode::NewFile);
        self.input_buf.clear();
        self.input_target = None;
    }

    /// Start creating a new folder in the selected directory.
    pub fn start_new_folder(&mut self) {
        if self.nodes.is_empty() {
            return;
        }
        self.input_mode = Some(TreeInputMode::NewFolder);
        self.input_buf.clear();
        self.input_target = None;
    }

    /// Start renaming the selected item.
    pub fn start_rename(&mut self) {
        if let Some(node) = self.nodes.get(self.selected) {
            self.input_mode = Some(TreeInputMode::Rename);
            self.input_buf = node.name.clone();
            self.input_target = Some(node.path.clone());
        }
    }

    /// Type a character into the input buffer.
    pub fn input_char(&mut self, c: char) {
        self.input_buf.push(c);
    }

    /// Delete last char from input buffer.
    pub fn input_backspace(&mut self) {
        self.input_buf.pop();
    }

    /// Cancel inline input.
    pub fn cancel_input(&mut self) {
        self.input_mode = None;
        self.input_buf.clear();
        self.input_target = None;
    }

    /// Confirm inline input — creates the file/folder or performs rename.
    /// Returns `Ok(Some(message))` on success, `Ok(None)` if nothing happened.
    pub fn confirm_input(&mut self) -> Result<Option<String>, String> {
        let mode = match self.input_mode {
            Some(m) => m,
            None => return Ok(None),
        };

        let name = self.input_buf.trim().to_string();
        if name.is_empty() {
            self.cancel_input();
            return Ok(None);
        }

        let result = match mode {
            TreeInputMode::NewFile => {
                let parent = self.selected_parent_dir()
                    .ok_or_else(|| "No directory selected".to_string())?;
                let path = parent.join(&name);
                if path.exists() {
                    return Err(format!("'{}' already exists", name));
                }
                // Create intermediate dirs if the name contains separators
                if let Some(p) = path.parent() {
                    fs::create_dir_all(p).map_err(|e| format!("mkdir failed: {}", e))?;
                }
                fs::File::create(&path).map_err(|e| format!("create failed: {}", e))?;
                Ok(Some(format!("Created {}", name)))
            }
            TreeInputMode::NewFolder => {
                let parent = self.selected_parent_dir()
                    .ok_or_else(|| "No directory selected".to_string())?;
                let path = parent.join(&name);
                if path.exists() {
                    return Err(format!("'{}' already exists", name));
                }
                fs::create_dir_all(&path).map_err(|e| format!("mkdir failed: {}", e))?;
                Ok(Some(format!("Created folder {}", name)))
            }
            TreeInputMode::Rename => {
                let old_path = self.input_target.clone()
                    .ok_or_else(|| "No rename target".to_string())?;
                let new_path = old_path.parent()
                    .ok_or_else(|| "Cannot determine parent".to_string())?
                    .join(&name);
                if new_path.exists() && new_path != old_path {
                    return Err(format!("'{}' already exists", name));
                }
                fs::rename(&old_path, &new_path)
                    .map_err(|e| format!("rename failed: {}", e))?;
                let old_name = old_path.file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default();
                Ok(Some(format!("Renamed '{}' → '{}'", old_name, name)))
            }
        };

        self.cancel_input();
        result
    }

    /// Delete the selected file/folder. Returns `Ok(message)` or `Err`.
    pub fn delete_selected(&self) -> Result<String, String> {
        let node = self.nodes.get(self.selected)
            .ok_or_else(|| "Nothing selected".to_string())?;
        let path = &node.path;
        let name = &node.name;

        if node.is_dir {
            // Try removing as empty dir first; fall back to remove_dir_all
            if fs::remove_dir(path).is_ok() {
                return Ok(format!("Deleted empty folder '{}'", name));
            }
            fs::remove_dir_all(path)
                .map_err(|e| format!("delete folder failed: {}", e))?;
            Ok(format!("Deleted folder '{}'", name))
        } else {
            fs::remove_file(path)
                .map_err(|e| format!("delete failed: {}", e))?;
            Ok(format!("Deleted '{}'", name))
        }
    }

    /// Duplicate the selected file. Returns `Ok(new_path_display)` or `Err`.
    pub fn duplicate_selected(&mut self) -> Result<String, String> {
        let node = self.nodes.get(self.selected)
            .ok_or_else(|| "Nothing selected".to_string())?;
        if node.is_dir {
            return Err("Cannot duplicate a directory".to_string());
        }
        let path = &node.path;
        let parent = path.parent()
            .ok_or_else(|| "Cannot determine parent".to_string())?;
        let stem = path.file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        let ext = path.extension()
            .map(|e| format!(".{}", e.to_string_lossy()))
            .unwrap_or_default();
        let new_name = format!("{} (copy){}", stem, ext);
        let new_path = parent.join(&new_name);
        fs::copy(path, &new_path)
            .map_err(|e| format!("copy failed: {}", e))?;
        Ok(format!("Duplicated as '{}'", new_name))
    }

    /// Start a move operation — marks the selected item as the source.
    pub fn start_move(&mut self) {
        if !self.nodes.is_empty() {
            self.move_source = Some(self.selected);
        }
    }

    /// Complete a move — moves the source to the selected directory.
    /// Returns `Ok(message)` or `Err`.
    pub fn complete_move(&mut self) -> Result<String, String> {
        let src_idx = self.move_source.take()
            .ok_or_else(|| "No move source".to_string())?;
        let src_node = self.nodes.get(src_idx)
            .ok_or_else(|| "Source no longer exists in tree".to_string())?;
        let src_path = src_node.path.clone();
        let src_name = src_node.name.clone();

        let dest_dir = self.selected_parent_dir()
            .ok_or_else(|| "No destination directory".to_string())?;
        let dest_path = dest_dir.join(&src_name);

        if dest_path == src_path {
            return Err("Source and destination are the same".to_string());
        }
        if dest_path.exists() {
            return Err(format!("'{}' already exists at destination", src_name));
        }

        fs::rename(&src_path, &dest_path)
            .map_err(|e| format!("move failed: {}", e))?;
        Ok(format!("Moved '{}' to '{}'", src_name, dest_dir.display()))
    }

    /// Cancel a pending move.
    pub fn cancel_move(&mut self) {
        self.move_source = None;
    }

    /// Whether input mode is active.
    pub fn is_input_active(&self) -> bool {
        self.input_mode.is_some()
    }

    /// Whether a move is pending.
    pub fn is_move_pending(&self) -> bool {
        self.move_source.is_some()
    }

    /// Get input state for rendering: `(mode, buffer_text)`.
    #[allow(dead_code)]
    pub fn input_state(&self) -> Option<(TreeInputMode, &str)> {
        self.input_mode.map(|m| (m, self.input_buf.as_str()))
    }

    // -----------------------------------------------------------------------
    // Mouse support
    // -----------------------------------------------------------------------

    /// Select the item at the given screen row within the tree area.
    /// Returns the index that was selected, or None.
    pub fn click_at_row(&mut self, row: usize) -> Option<usize> {
        let idx = self.scroll + row;
        if idx < self.nodes.len() {
            self.selected = idx;
            Some(idx)
        } else {
            None
        }
    }

    /// Scroll the tree by delta lines (negative = up).
    pub fn scroll_by(&mut self, delta: i32, visible_height: usize) {
        if delta < 0 {
            self.scroll = self.scroll.saturating_sub((-delta) as usize);
        } else {
            let max = self.nodes.len().saturating_sub(visible_height);
            self.scroll = (self.scroll + delta as usize).min(max);
        }
    }

    /// Check if a node at index is a directory.
    #[allow(dead_code)]
    pub fn is_dir_at(&self, idx: usize) -> bool {
        self.nodes.get(idx).map_or(false, |n| n.is_dir)
    }

    // -----------------------------------------------------------------------
    // Rendering
    // -----------------------------------------------------------------------

    pub fn render(&mut self, frame: &mut Frame, area: Rect, theme: &Theme, is_focused: bool) {
        let border_style = if is_focused {
            Style::default().fg(theme.accent)
        } else {
            Style::default().fg(theme.border)
        };

        let title_label = if self.move_source.is_some() {
            " Files (move pending) "
        } else {
            " Files "
        };

        let title = Span::styled(
            title_label,
            Style::default()
                .fg(if is_focused { theme.accent } else { theme.text_muted })
                .add_modifier(if is_focused { Modifier::BOLD } else { Modifier::empty() }),
        );

        let block = Block::default()
            .borders(Borders::ALL)
            .border_style(border_style)
            .title(title)
            .style(Style::default().bg(theme.bg_surface));

        let inner = block.inner(area);
        frame.render_widget(block, area);

        if inner.height == 0 || self.nodes.is_empty() {
            return;
        }

        // Reserve one row for the inline input line when active (NewFile/NewFolder).
        // Rename replaces the selected item's name, so no extra row needed.
        let input_row_needed = matches!(self.input_mode, Some(TreeInputMode::NewFile) | Some(TreeInputMode::NewFolder));
        let visible = if input_row_needed {
            (inner.height as usize).saturating_sub(1)
        } else {
            inner.height as usize
        };

        // Keep selected item in view
        if self.selected < self.scroll {
            self.scroll = self.selected;
        } else if self.selected >= self.scroll + visible {
            self.scroll = self.selected - visible + 1;
        }

        let max_w = inner.width as usize;
        let is_renaming = self.input_mode == Some(TreeInputMode::Rename);

        let items: Vec<ListItem> = self
            .nodes
            .iter()
            .enumerate()
            .skip(self.scroll)
            .take(visible)
            .map(|(i, node)| {
                let is_sel = i == self.selected;
                let is_move_src = self.move_source == Some(i);

                let indent = "  ".repeat(node.depth);
                let icon = if node.is_dir {
                    if node.expanded { "▼ " } else { "▶ " }
                } else {
                    "  "
                };

                // For rename mode, replace the selected item's name with the input buffer
                let name_part = if is_sel && is_renaming {
                    format!("{}|", self.input_buf)
                } else {
                    node.name.clone()
                };

                let move_indicator = if is_move_src { " ✂" } else { "" };

                let status_badge: &str = match node.git_status {
                    'M' => " M",
                    'A' => " A",
                    'D' => " D",
                    '?' => " ?",
                    _ => "",
                };

                // Truncate name to fit, leaving room for indent, icon, badge, move indicator
                let overhead = indent.len() + icon.len() + status_badge.len() + move_indicator.len();
                let name_max = max_w.saturating_sub(overhead);
                let name_display: String = name_part.chars().take(name_max).collect();

                let label = format!("{}{}{}{}{}", indent, icon, name_display, status_badge, move_indicator);

                let (fg, bg) = if is_sel && is_renaming {
                    // Highlight the rename input
                    (theme.text, theme.accent)
                } else if is_sel {
                    (Color::White, theme.accent)
                } else if is_move_src {
                    (theme.text_muted, theme.bg_surface)
                } else {
                    let fg = match node.git_status {
                        'M' => theme.amber,
                        'A' => theme.green,
                        'D' => theme.red,
                        '?' => theme.text_muted,
                        _ if node.is_dir => theme.blue,
                        _ => theme.text,
                    };
                    (fg, theme.bg_surface)
                };

                ListItem::new(Line::from(Span::styled(
                    label,
                    Style::default().fg(fg).bg(bg),
                )))
            })
            .collect();

        let list_area = if input_row_needed {
            Rect::new(inner.x, inner.y, inner.width, visible as u16)
        } else {
            inner
        };

        frame.render_widget(
            List::new(items).style(Style::default().bg(theme.bg_surface)),
            list_area,
        );

        // Render the inline input row for NewFile / NewFolder
        if input_row_needed {
            let input_y = inner.y + visible as u16;
            if input_y < inner.y + inner.height {
                let prompt_label = match self.input_mode {
                    Some(TreeInputMode::NewFile) => "  + ",
                    Some(TreeInputMode::NewFolder) => "  ▶ ",
                    _ => "  > ",
                };
                let input_display = format!("{}{}|", prompt_label, self.input_buf);
                let truncated: String = input_display.chars().take(max_w).collect();
                let input_area = Rect::new(inner.x, input_y, inner.width, 1);
                frame.render_widget(
                    ratatui::widgets::Paragraph::new(Line::from(Span::styled(
                        truncated,
                        Style::default().fg(theme.text).bg(theme.accent),
                    ))),
                    input_area,
                );
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Git status helpers
// ---------------------------------------------------------------------------

fn load_git_statuses(cwd: &str) -> HashMap<String, char> {
    let mut map = HashMap::new();

    let Ok(out) = std::process::Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(cwd)
        .output()
    else {
        return map;
    };

    let text = String::from_utf8_lossy(&out.stdout);
    for line in text.lines() {
        if line.len() < 4 {
            continue;
        }
        let xy = line.as_bytes();
        let x = xy[0] as char;
        let y = xy[1] as char;
        let path_part = &line[3..];

        let path = if path_part.contains(" -> ") {
            path_part.split(" -> ").nth(1).unwrap_or(path_part).trim_matches('"').to_string()
        } else {
            path_part.trim_matches('"').to_string()
        };

        let status = match (x, y) {
            ('?', '?') => '?',
            ('D', _) | (_, 'D') => 'D',
            ('A', _) | (_, 'A') => 'A',
            _ => 'M',
        };

        map.insert(path, status);
    }

    map
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn make_tree() -> FileTree {
        FileTree::new()
    }

    #[test]
    fn input_char_and_backspace() {
        let mut tree = make_tree();
        tree.input_mode = Some(TreeInputMode::NewFile);
        tree.input_char('h');
        tree.input_char('i');
        assert_eq!(tree.input_buf, "hi");
        tree.input_backspace();
        assert_eq!(tree.input_buf, "h");
        tree.input_backspace();
        assert_eq!(tree.input_buf, "");
        // Backspace on empty is a no-op
        tree.input_backspace();
        assert_eq!(tree.input_buf, "");
    }

    #[test]
    fn start_new_file_sets_mode() {
        let mut tree = make_tree();
        // With no nodes, start_new_file is a no-op
        tree.start_new_file();
        assert!(tree.input_mode.is_none());

        // Add a fake node so operations work
        tree.nodes.push(TreeNode {
            name: "src".into(),
            path: PathBuf::from("/tmp/src"),
            is_dir: true,
            expanded: false,
            depth: 0,
            git_status: ' ',
        });
        tree.start_new_file();
        assert_eq!(tree.input_mode, Some(TreeInputMode::NewFile));
        assert!(tree.input_buf.is_empty());
    }

    #[test]
    fn start_new_folder_sets_mode() {
        let mut tree = make_tree();
        tree.nodes.push(TreeNode {
            name: "src".into(),
            path: PathBuf::from("/tmp/src"),
            is_dir: true,
            expanded: false,
            depth: 0,
            git_status: ' ',
        });
        tree.start_new_folder();
        assert_eq!(tree.input_mode, Some(TreeInputMode::NewFolder));
        assert!(tree.input_buf.is_empty());
    }

    #[test]
    fn cancel_input_clears_state() {
        let mut tree = make_tree();
        tree.input_mode = Some(TreeInputMode::Rename);
        tree.input_buf = "hello".into();
        tree.input_target = Some(PathBuf::from("/tmp/hello"));
        tree.cancel_input();
        assert!(tree.input_mode.is_none());
        assert!(tree.input_buf.is_empty());
        assert!(tree.input_target.is_none());
    }

    #[test]
    fn start_rename_prefills_name() {
        let mut tree = make_tree();
        tree.nodes.push(TreeNode {
            name: "foo.rs".into(),
            path: PathBuf::from("/tmp/foo.rs"),
            is_dir: false,
            expanded: false,
            depth: 0,
            git_status: ' ',
        });
        tree.selected = 0;
        tree.start_rename();
        assert_eq!(tree.input_mode, Some(TreeInputMode::Rename));
        assert_eq!(tree.input_buf, "foo.rs");
        assert_eq!(tree.input_target, Some(PathBuf::from("/tmp/foo.rs")));
    }

    #[test]
    fn start_move_and_cancel_move() {
        let mut tree = make_tree();
        tree.nodes.push(TreeNode {
            name: "a.txt".into(),
            path: PathBuf::from("/tmp/a.txt"),
            is_dir: false,
            expanded: false,
            depth: 0,
            git_status: ' ',
        });
        tree.selected = 0;
        tree.start_move();
        assert_eq!(tree.move_source, Some(0));
        assert!(tree.is_move_pending());
        tree.cancel_move();
        assert!(tree.move_source.is_none());
        assert!(!tree.is_move_pending());
    }

    #[test]
    fn is_input_active_reflects_mode() {
        let mut tree = make_tree();
        assert!(!tree.is_input_active());
        tree.input_mode = Some(TreeInputMode::NewFile);
        assert!(tree.is_input_active());
    }

    #[test]
    fn input_state_returns_mode_and_buf() {
        let mut tree = make_tree();
        assert!(tree.input_state().is_none());
        tree.input_mode = Some(TreeInputMode::NewFolder);
        tree.input_buf = "test".into();
        let (mode, buf) = tree.input_state().unwrap();
        assert_eq!(mode, TreeInputMode::NewFolder);
        assert_eq!(buf, "test");
    }

    #[test]
    fn confirm_input_empty_name_cancels() {
        let mut tree = make_tree();
        tree.nodes.push(TreeNode {
            name: "src".into(),
            path: PathBuf::from("/tmp/src"),
            is_dir: true,
            expanded: false,
            depth: 0,
            git_status: ' ',
        });
        tree.input_mode = Some(TreeInputMode::NewFile);
        tree.input_buf = "   ".into(); // whitespace only
        let result = tree.confirm_input();
        assert!(matches!(result, Ok(None)));
        assert!(tree.input_mode.is_none());
    }
}
