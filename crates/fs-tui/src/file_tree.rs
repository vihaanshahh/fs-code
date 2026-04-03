//! File tree sidebar — persistent left panel showing directory structure.
//!
//! Toggle with Ctrl+E. Navigate with j/k or arrows.
//! Enter/Space to expand dirs or open files in editor.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

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
}

impl FileTree {
    pub fn new() -> Self {
        Self {
            nodes: Vec::new(),
            selected: 0,
            scroll: 0,
            cwd: String::new(),
            git_statuses: HashMap::new(),
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
    // Rendering
    // -----------------------------------------------------------------------

    pub fn render(&mut self, frame: &mut Frame, area: Rect, theme: &Theme, is_focused: bool) {
        let border_style = if is_focused {
            Style::default().fg(theme.accent)
        } else {
            Style::default().fg(theme.border)
        };

        let title = Span::styled(
            " Files ",
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

        let visible = inner.height as usize;

        // Keep selected item in view
        if self.selected < self.scroll {
            self.scroll = self.selected;
        } else if self.selected >= self.scroll + visible {
            self.scroll = self.selected - visible + 1;
        }

        let max_w = inner.width as usize;

        let items: Vec<ListItem> = self
            .nodes
            .iter()
            .enumerate()
            .skip(self.scroll)
            .take(visible)
            .map(|(i, node)| {
                let is_sel = i == self.selected;

                let indent = "  ".repeat(node.depth);
                let icon = if node.is_dir {
                    if node.expanded { "▼ " } else { "▶ " }
                } else {
                    "  "
                };

                let status_badge: &str = match node.git_status {
                    'M' => " M",
                    'A' => " A",
                    'D' => " D",
                    '?' => " ?",
                    _ => "",
                };

                // Truncate name to fit, leaving room for indent, icon, badge
                let overhead = indent.len() + icon.len() + status_badge.len();
                let name_max = max_w.saturating_sub(overhead);
                let name_display: String = node.name.chars().take(name_max).collect();

                let label = format!("{}{}{}{}", indent, icon, name_display, status_badge);

                let (fg, bg) = if is_sel {
                    (theme.bg, theme.accent)
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

        frame.render_widget(
            List::new(items).style(Style::default().bg(theme.bg_surface)),
            inner,
        );
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
