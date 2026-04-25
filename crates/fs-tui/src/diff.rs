//! Diff view — side-by-side or unified diff display with color-coded changes.
//!
//! Supports viewing git diffs for files, with proper line-by-line coloring:
//!   - Green background for additions
//!   - Red background for deletions
//!   - Yellow for modified lines (in side-by-side mode)
//!   - Context lines in default color

use ratatui::prelude::*;
use ratatui::widgets::{Block, Borders, Clear, Paragraph, Scrollbar, ScrollbarOrientation, ScrollbarState};

use crate::theme::Theme;

// ---------------------------------------------------------------------------
// Diff types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub enum DiffLineKind {
    Context,
    Added,
    Removed,
    Header,
}

#[derive(Debug, Clone)]
pub struct DiffLine {
    pub kind: DiffLineKind,
    pub old_num: Option<usize>,
    pub new_num: Option<usize>,
    pub content: String,
}

#[derive(Debug, Clone)]
pub struct FileDiff {
    pub path: String,
    pub lines: Vec<DiffLine>,
    pub additions: usize,
    pub deletions: usize,
}

// ---------------------------------------------------------------------------
// Parse unified diff output
// ---------------------------------------------------------------------------

pub fn parse_unified_diff(diff_text: &str) -> Vec<FileDiff> {
    let mut diffs = Vec::new();
    let mut current: Option<FileDiff> = None;
    let mut old_line: usize = 0;
    let mut new_line: usize = 0;

    for line in diff_text.lines() {
        if line.starts_with("diff --git") {
            if let Some(d) = current.take() {
                diffs.push(d);
            }
            // Extract file path from "diff --git a/path b/path"
            let path = line
                .split(" b/")
                .nth(1)
                .unwrap_or("unknown")
                .to_string();
            current = Some(FileDiff {
                path,
                lines: Vec::new(),
                additions: 0,
                deletions: 0,
            });
        } else if let Some(ref mut diff) = current {
            if line.starts_with("@@") {
                // Parse hunk header: @@ -old,count +new,count @@
                if let Some((o, n)) = parse_hunk_header(line) {
                    old_line = o;
                    new_line = n;
                }
                diff.lines.push(DiffLine {
                    kind: DiffLineKind::Header,
                    old_num: None,
                    new_num: None,
                    content: line.to_string(),
                });
            } else if line.starts_with('+') && !line.starts_with("+++") {
                diff.additions += 1;
                diff.lines.push(DiffLine {
                    kind: DiffLineKind::Added,
                    old_num: None,
                    new_num: Some(new_line),
                    content: line[1..].to_string(),
                });
                new_line += 1;
            } else if line.starts_with('-') && !line.starts_with("---") {
                diff.deletions += 1;
                diff.lines.push(DiffLine {
                    kind: DiffLineKind::Removed,
                    old_num: Some(old_line),
                    new_num: None,
                    content: line[1..].to_string(),
                });
                old_line += 1;
            } else if line.starts_with(' ') || line.is_empty() {
                let content = if line.is_empty() {
                    String::new()
                } else {
                    line[1..].to_string()
                };
                diff.lines.push(DiffLine {
                    kind: DiffLineKind::Context,
                    old_num: Some(old_line),
                    new_num: Some(new_line),
                    content,
                });
                old_line += 1;
                new_line += 1;
            }
        }
    }

    if let Some(d) = current {
        diffs.push(d);
    }
    diffs
}

fn parse_hunk_header(line: &str) -> Option<(usize, usize)> {
    // @@ -10,5 +12,8 @@ optional context
    let parts: Vec<&str> = line.split_whitespace().collect();
    if parts.len() < 3 {
        return None;
    }
    let old = parts[1]
        .trim_start_matches('-')
        .split(',')
        .next()?
        .parse::<usize>()
        .ok()?;
    let new = parts[2]
        .trim_start_matches('+')
        .split(',')
        .next()?
        .parse::<usize>()
        .ok()?;
    Some((old, new))
}

// ---------------------------------------------------------------------------
// Generate unified diff from two strings (for AI edit preview)
// ---------------------------------------------------------------------------

/// Produce a unified diff string from old and new content for a given file path.
/// Uses a simple O(nm) LCS diff — fine for typical file sizes.
pub fn unified_diff(path: &str, old: &str, new: &str) -> String {
    let old_lines: Vec<&str> = old.lines().collect();
    let new_lines: Vec<&str> = new.lines().collect();

    // LCS table
    let n = old_lines.len();
    let m = new_lines.len();
    let mut dp = vec![vec![0u32; m + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            dp[i][j] = if old_lines[i] == new_lines[j] {
                dp[i + 1][j + 1] + 1
            } else {
                dp[i + 1][j].max(dp[i][j + 1])
            };
        }
    }

    // Walk the LCS table to produce edit operations
    #[derive(Clone, Copy)]
    enum Op { Keep, Remove, Add }
    let mut ops: Vec<(Op, usize, usize)> = Vec::new(); // (op, old_idx, new_idx)
    let (mut i, mut j) = (0, 0);
    while i < n || j < m {
        if i < n && j < m && old_lines[i] == new_lines[j] {
            ops.push((Op::Keep, i, j));
            i += 1;
            j += 1;
        } else if j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j]) {
            ops.push((Op::Add, i, j));
            j += 1;
        } else {
            ops.push((Op::Remove, i, j));
            i += 1;
        }
    }

    // Group into hunks with 3 lines of context
    let ctx = 3usize;
    let mut hunks: Vec<(usize, usize)> = Vec::new(); // (start, end) indices into ops
    let mut hunk_start: Option<usize> = None;
    let mut last_change: Option<usize> = None;

    for (idx, (op, _, _)) in ops.iter().enumerate() {
        if !matches!(op, Op::Keep) {
            if hunk_start.is_none() {
                hunk_start = Some(idx.saturating_sub(ctx));
            }
            last_change = Some(idx);
        } else if let Some(lc) = last_change {
            if idx - lc > ctx * 2 {
                hunks.push((hunk_start.unwrap(), (lc + ctx + 1).min(ops.len())));
                hunk_start = None;
                last_change = None;
            }
        }
    }
    if let (Some(hs), Some(lc)) = (hunk_start, last_change) {
        hunks.push((hs, (lc + ctx + 1).min(ops.len())));
    }

    if hunks.is_empty() {
        return String::new(); // no changes
    }

    let mut out = String::new();
    out.push_str(&format!("diff --git a/{path} b/{path}\n"));
    out.push_str(&format!("--- a/{path}\n"));
    out.push_str(&format!("+++ b/{path}\n"));

    for (start, end) in &hunks {
        // Compute hunk header line numbers
        let mut old_start = 0;
        let mut old_count = 0;
        let mut new_start = 0;
        let mut new_count = 0;
        let mut first = true;

        for idx in *start..*end {
            let (op, oi, ni) = ops[idx];
            match op {
                Op::Keep => {
                    if first { old_start = oi + 1; new_start = ni + 1; first = false; }
                    old_count += 1;
                    new_count += 1;
                }
                Op::Remove => {
                    if first { old_start = oi + 1; new_start = ni + 1; first = false; }
                    old_count += 1;
                }
                Op::Add => {
                    if first { old_start = oi + 1; new_start = ni + 1; first = false; }
                    new_count += 1;
                }
            }
        }

        out.push_str(&format!("@@ -{},{} +{},{} @@\n", old_start, old_count, new_start, new_count));

        for idx in *start..*end {
            let (op, oi, ni) = ops[idx];
            match op {
                Op::Keep   => out.push_str(&format!(" {}\n", old_lines[oi])),
                Op::Remove => out.push_str(&format!("-{}\n", old_lines[oi])),
                Op::Add    => out.push_str(&format!("+{}\n", new_lines[ni])),
            }
        }
    }

    out
}

// ---------------------------------------------------------------------------
// Diff viewer state
// ---------------------------------------------------------------------------

pub struct DiffViewer {
    pub diffs: Vec<FileDiff>,
    pub scroll: usize,
    pub active_file: usize,
    open: bool,
    viewport_height: usize,
}

impl DiffViewer {
    pub fn new() -> Self {
        Self {
            diffs: Vec::new(),
            scroll: 0,
            active_file: 0,
            open: false,
            viewport_height: 0,
        }
    }

    pub fn open_with(&mut self, diff_text: &str) {
        self.diffs = parse_unified_diff(diff_text);
        self.scroll = 0;
        self.active_file = 0;
        self.open = true;
    }

    pub fn close(&mut self) {
        self.open = false;
        self.diffs.clear();
    }

    pub fn scroll_up(&mut self, n: usize) {
        self.scroll = self.scroll.saturating_sub(n);
    }

    pub fn scroll_down(&mut self, n: usize) {
        // Allow overscroll: the user can scroll until the last diff line
        // sits on the top row of the viewport, with empty rows below.
        // Otherwise the last line is pinned to the bottom row, which
        // makes it feel like the end of long diffs is unreachable.
        let max = self.total_lines().saturating_sub(1);
        self.scroll = (self.scroll + n).min(max);
    }

    pub fn next_file(&mut self) {
        if !self.diffs.is_empty() {
            self.active_file = (self.active_file + 1) % self.diffs.len();
            self.scroll = 0;
        }
    }

    pub fn prev_file(&mut self) {
        if !self.diffs.is_empty() {
            self.active_file = (self.active_file + self.diffs.len() - 1) % self.diffs.len();
            self.scroll = 0;
        }
    }

    /// Returns the source file line number (0-indexed) at the current scroll position.
    pub fn current_source_line(&self) -> usize {
        let diff = match self.diffs.get(self.active_file) {
            Some(d) => d,
            None => return 0,
        };
        for line in diff.lines[self.scroll..].iter() {
            if let Some(n) = line.new_num.or(line.old_num) {
                return n.saturating_sub(1);
            }
        }
        0
    }

    fn total_lines(&self) -> usize {
        self.diffs
            .get(self.active_file)
            .map(|d| d.lines.len())
            .unwrap_or(0)
    }

    pub fn render(&mut self, frame: &mut Frame, area: Rect, theme: &Theme) {
        let diff = match self.diffs.get(self.active_file) {
            Some(d) => d,
            None => {
                let msg = Paragraph::new("No diffs to display")
                    .alignment(Alignment::Center)
                    .block(Block::default().borders(Borders::ALL).title(" Diff "));
                frame.render_widget(msg, area);
                return;
            }
        };

        let title = format!(
            " {} (+{} -{}) [{}/{}] ",
            diff.path, diff.additions, diff.deletions,
            self.active_file + 1, self.diffs.len(),
        );

        let block = Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(theme.text))
            .title(Span::styled(
                title,
                Style::default().fg(theme.text).add_modifier(Modifier::BOLD),
            ))
            .title_bottom(Span::styled(
                " ←/→ files │ ^↑/↓ line │ j/k×5 │ PgUp/Dn×40 │ e edit │ Esc close ",
                Style::default().fg(theme.text_muted),
            ));

        let inner = block.inner(area);
        frame.render_widget(Clear, area);
        frame.render_widget(block, area);

        if inner.height == 0 {
            return;
        }

        // Gutter width (line numbers)
        let gutter_w = 8u16; // "  123 │ "
        let content_w = inner.width.saturating_sub(gutter_w);

        let visible_lines = inner.height as usize;
        self.viewport_height = visible_lines;
        let start = self.scroll;
        let end = (start + visible_lines).min(diff.lines.len());

        for (i, line) in diff.lines[start..end].iter().enumerate() {
            let y = inner.y + i as u16;

            // Gutter: line number
            let gutter_text = match (&line.kind, line.new_num, line.old_num) {
                (DiffLineKind::Added, Some(n), _) => format!("{:>4} │ ", n),
                (DiffLineKind::Removed, _, Some(n)) => format!("{:>4} │ ", n),
                (DiffLineKind::Context, _, Some(n)) => format!("{:>4} │ ", n),
                _ => "     │ ".to_string(),
            };

            let gutter_style = Style::default().fg(theme.text_muted);
            frame
                .buffer_mut()
                .set_string(inner.x, y, &gutter_text, gutter_style);

            // Content with diff coloring
            let (fg, bg, prefix) = match line.kind {
                DiffLineKind::Added   => (theme.green,          theme.diff_add_bg,    "+"),
                DiffLineKind::Removed => (theme.red,            theme.diff_remove_bg, "-"),
                DiffLineKind::Header  => (theme.text_muted,      Color::Reset,         "@"),
                DiffLineKind::Context => (theme.text,            Color::Reset,         " "),
            };

            let display = format!("{}{}", prefix, line.content);
            let truncated: String = display.chars().take(content_w as usize).collect();
            let style = Style::default().fg(fg).bg(bg);

            frame.buffer_mut().set_string(
                inner.x + gutter_w,
                y,
                &truncated,
                style,
            );

            // Fill remaining width with bg color for added/removed lines
            if matches!(line.kind, DiffLineKind::Added | DiffLineKind::Removed) {
                let remaining = content_w.saturating_sub(truncated.len() as u16);
                if remaining > 0 {
                    frame.buffer_mut().set_string(
                        inner.x + gutter_w + truncated.len() as u16,
                        y,
                        &" ".repeat(remaining as usize),
                        Style::default().bg(bg),
                    );
                }
            }
        }

        // Scrollbar
        if diff.lines.len() > visible_lines {
            let mut scrollbar_state =
                ScrollbarState::new(diff.lines.len()).position(self.scroll);
            frame.render_stateful_widget(
                Scrollbar::new(ScrollbarOrientation::VerticalRight),
                inner,
                &mut scrollbar_state,
            );
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_simple_diff() {
        let diff_text = r#"diff --git a/foo.rs b/foo.rs
--- a/foo.rs
+++ b/foo.rs
@@ -1,3 +1,4 @@
 fn main() {
+    println!("hello");
     let x = 1;
 }
"#;
        let diffs = parse_unified_diff(diff_text);
        assert_eq!(diffs.len(), 1);
        assert_eq!(diffs[0].path, "foo.rs");
        assert_eq!(diffs[0].additions, 1);
        assert_eq!(diffs[0].deletions, 0);
        assert_eq!(diffs[0].lines.len(), 5); // header + 2 context + 1 added + 1 context
    }

    #[test]
    fn scroll_down_overscrolls_to_last_line() {
        // Overscroll: the user can scroll until the last line lands on
        // the *top* row of the viewport (scroll = total - 1), not just
        // the bottom row (which would be 80 with a 20-row viewport).
        let lines: Vec<DiffLine> = (0..100)
            .map(|i| DiffLine {
                kind: DiffLineKind::Context,
                old_num: Some(i + 1),
                new_num: Some(i + 1),
                content: format!("line {i}"),
            })
            .collect();
        let mut viewer = DiffViewer::new();
        viewer.diffs = vec![FileDiff {
            path: "test.txt".into(),
            lines,
            additions: 0,
            deletions: 0,
        }];
        viewer.viewport_height = 20;

        viewer.scroll_down(10_000);

        assert_eq!(viewer.scroll, 99);
    }

    #[test]
    fn parse_multiple_files() {
        let diff_text = r#"diff --git a/a.rs b/a.rs
--- a/a.rs
+++ b/a.rs
@@ -1,2 +1,2 @@
-old line
+new line
diff --git a/b.rs b/b.rs
--- a/b.rs
+++ b/b.rs
@@ -1,1 +1,2 @@
 existing
+added
"#;
        let diffs = parse_unified_diff(diff_text);
        assert_eq!(diffs.len(), 2);
        assert_eq!(diffs[0].path, "a.rs");
        assert_eq!(diffs[1].path, "b.rs");
    }
}
