//! Minimal inline file editor — view and edit files within a pane.
//!
//! Features:
//!   - Syntax-aware line numbers with color
//!   - Cursor navigation (arrows, Home/End, PgUp/PgDn)
//!   - Basic editing (insert, delete, backspace, enter)
//!   - Save (Ctrl+S)
//!   - Dirty indicator
//!   - Scrolling with viewport tracking

use ratatui::prelude::*;
use ratatui::widgets::{Block, BorderType, Borders, Scrollbar, ScrollbarOrientation, ScrollbarState};

use crate::highlight::{self, Lang};
use crate::theme::Theme;

// ---------------------------------------------------------------------------
// Editor state
// ---------------------------------------------------------------------------

pub struct Editor {
    /// File path being edited
    pub path: String,
    /// Lines of content
    lines: Vec<String>,
    /// Cursor position (line, col)
    pub cursor: (usize, usize),
    /// Viewport scroll offset (first visible line)
    pub scroll: usize,
    /// Whether content has been modified
    pub dirty: bool,
    /// Whether the editor overlay is open
    open: bool,
    /// Viewport dimensions (set on render)
    viewport_height: usize,
    /// Detected language for syntax highlighting
    lang: Lang,
}

impl Editor {
    pub fn new() -> Self {
        Self {
            path: String::new(),
            lines: vec![String::new()],
            cursor: (0, 0),
            scroll: 0,
            dirty: false,
            open: false,
            viewport_height: 20,
            lang: Lang::Generic,
        }
    }

    pub fn is_open(&self) -> bool {
        self.open
    }

    /// Open a file for editing.
    pub fn open_file(&mut self, path: &str) -> Result<(), String> {
        let content = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
        self.path = path.to_string();
        self.lang = Lang::from_path(path);
        self.lines = content.lines().map(|l| l.to_string()).collect();
        if self.lines.is_empty() {
            self.lines.push(String::new());
        }
        self.cursor = (0, 0);
        self.scroll = 0;
        self.dirty = false;
        self.open = true;
        Ok(())
    }

    pub fn close(&mut self) {
        self.open = false;
    }

    /// Save file to disk.
    pub fn save(&mut self) -> Result<(), String> {
        let content = self.lines.join("\n") + "\n";
        std::fs::write(&self.path, content).map_err(|e| e.to_string())?;
        self.dirty = false;
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Cursor movement
    // -----------------------------------------------------------------------

    pub fn move_up(&mut self) {
        if self.cursor.0 > 0 {
            self.cursor.0 -= 1;
            self.clamp_col();
            self.ensure_visible();
        }
    }

    pub fn move_down(&mut self) {
        if self.cursor.0 < self.lines.len() - 1 {
            self.cursor.0 += 1;
            self.clamp_col();
            self.ensure_visible();
        }
    }

    pub fn move_left(&mut self) {
        if self.cursor.1 > 0 {
            self.cursor.1 -= 1;
        } else if self.cursor.0 > 0 {
            self.cursor.0 -= 1;
            self.cursor.1 = self.current_line_len();
            self.ensure_visible();
        }
    }

    pub fn move_right(&mut self) {
        let len = self.current_line_len();
        if self.cursor.1 < len {
            self.cursor.1 += 1;
        } else if self.cursor.0 < self.lines.len() - 1 {
            self.cursor.0 += 1;
            self.cursor.1 = 0;
            self.ensure_visible();
        }
    }

    pub fn move_home(&mut self) {
        self.cursor.1 = 0;
    }

    pub fn move_end(&mut self) {
        self.cursor.1 = self.current_line_len();
    }

    pub fn page_up(&mut self) {
        let jump = self.viewport_height.max(1);
        self.cursor.0 = self.cursor.0.saturating_sub(jump);
        self.clamp_col();
        self.ensure_visible();
    }

    pub fn page_down(&mut self) {
        let jump = self.viewport_height.max(1);
        self.cursor.0 = (self.cursor.0 + jump).min(self.lines.len() - 1);
        self.clamp_col();
        self.ensure_visible();
    }

    /// Jump 5 lines up (Ctrl+Up) — fast vertical movement.
    pub fn jump_up(&mut self) {
        self.cursor.0 = self.cursor.0.saturating_sub(5);
        self.clamp_col();
        self.ensure_visible();
    }

    /// Jump 5 lines down (Ctrl+Down) — fast vertical movement.
    pub fn jump_down(&mut self) {
        self.cursor.0 = (self.cursor.0 + 5).min(self.lines.len().saturating_sub(1));
        self.clamp_col();
        self.ensure_visible();
    }

    /// Jump one word left (Ctrl+Left).
    pub fn word_left(&mut self) {
        let line = &self.lines[self.cursor.0];
        let bytes = line.as_bytes();
        if self.cursor.1 == 0 {
            // Wrap to end of previous line
            if self.cursor.0 > 0 {
                self.cursor.0 -= 1;
                self.cursor.1 = self.current_line_len();
                self.ensure_visible();
            }
            return;
        }
        let mut col = self.cursor.1.min(line.len());
        // Skip whitespace/punctuation backwards
        while col > 0 && !bytes[col - 1].is_ascii_alphanumeric() && bytes[col - 1] != b'_' {
            col -= 1;
        }
        // Skip word chars backwards
        while col > 0 && (bytes[col - 1].is_ascii_alphanumeric() || bytes[col - 1] == b'_') {
            col -= 1;
        }
        self.cursor.1 = col;
    }

    /// Jump one word right (Ctrl+Right).
    pub fn word_right(&mut self) {
        let line = &self.lines[self.cursor.0];
        let len = line.len();
        let bytes = line.as_bytes();
        if self.cursor.1 >= len {
            // Wrap to start of next line
            if self.cursor.0 < self.lines.len() - 1 {
                self.cursor.0 += 1;
                self.cursor.1 = 0;
                self.ensure_visible();
            }
            return;
        }
        let mut col = self.cursor.1;
        // Skip current word chars
        while col < len && (bytes[col].is_ascii_alphanumeric() || bytes[col] == b'_') {
            col += 1;
        }
        // Skip whitespace/punctuation
        while col < len && !bytes[col].is_ascii_alphanumeric() && bytes[col] != b'_' {
            col += 1;
        }
        self.cursor.1 = col;
    }

    /// Jump to first line (Ctrl+Home).
    pub fn goto_top(&mut self) {
        self.cursor = (0, 0);
        self.scroll = 0;
    }

    /// Jump to last line (Ctrl+End).
    pub fn goto_bottom(&mut self) {
        self.cursor.0 = self.lines.len().saturating_sub(1);
        self.cursor.1 = 0;
        self.ensure_visible();
    }

    // -----------------------------------------------------------------------
    // Editing
    // -----------------------------------------------------------------------

    pub fn insert_char(&mut self, c: char) {
        let col = self.cursor.1.min(self.lines[self.cursor.0].len());
        self.lines[self.cursor.0].insert(col, c);
        self.cursor.1 = col + 1;
        self.dirty = true;
    }

    /// Insert a multi-character string (e.g. from a paste operation).
    pub fn insert_text(&mut self, text: &str) {
        for c in text.chars() {
            if c == '\n' || c == '\r' {
                self.insert_newline();
            } else {
                self.insert_char(c);
            }
        }
    }

    pub fn insert_newline(&mut self) {
        let line = self.cursor.0;
        let col = self.cursor.1.min(self.lines[line].len());
        // Capture leading whitespace from current line for auto-indent.
        let indent: String = self.lines[line]
            .chars()
            .take_while(|c| *c == ' ' || *c == '\t')
            .collect();
        let rest = self.lines[line][col..].to_string();
        self.lines[line].truncate(col);
        let new_line = format!("{}{}", indent, rest);
        let indent_len = indent.len();
        self.lines.insert(line + 1, new_line);
        self.cursor.0 += 1;
        self.cursor.1 = indent_len;
        self.dirty = true;
        self.ensure_visible();
    }

    /// Delete the entire current line (Ctrl+D).
    pub fn delete_line(&mut self) {
        if self.lines.len() > 1 {
            self.lines.remove(self.cursor.0);
            if self.cursor.0 >= self.lines.len() {
                self.cursor.0 = self.lines.len() - 1;
            }
            self.clamp_col();
            self.dirty = true;
            self.ensure_visible();
        } else {
            // Last line — just clear it
            self.lines[0].clear();
            self.cursor.1 = 0;
            self.dirty = true;
        }
    }

    /// Duplicate the current line below (Ctrl+Shift+D).
    pub fn duplicate_line(&mut self) {
        let dup = self.lines[self.cursor.0].clone();
        self.lines.insert(self.cursor.0 + 1, dup);
        self.cursor.0 += 1;
        self.dirty = true;
        self.ensure_visible();
    }

    pub fn backspace(&mut self) {
        if self.cursor.1 > 0 {
            let col = self.cursor.1.min(self.lines[self.cursor.0].len());
            if col > 0 {
                self.lines[self.cursor.0].remove(col - 1);
                self.cursor.1 = col - 1;
                self.dirty = true;
            }
        } else if self.cursor.0 > 0 {
            // Join with previous line
            let current = self.lines.remove(self.cursor.0);
            self.cursor.0 -= 1;
            self.cursor.1 = self.lines[self.cursor.0].len();
            self.lines[self.cursor.0].push_str(&current);
            self.dirty = true;
            self.ensure_visible();
        }
    }

    pub fn delete_char(&mut self) {
        let len = self.current_line_len();
        if self.cursor.1 < len {
            let col = self.cursor.1;
            self.lines[self.cursor.0].remove(col);
            self.dirty = true;
        } else if self.cursor.0 < self.lines.len() - 1 {
            // Join with next line
            let next = self.lines.remove(self.cursor.0 + 1);
            self.lines[self.cursor.0].push_str(&next);
            self.dirty = true;
        }
    }

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    fn current_line_len(&self) -> usize {
        self.lines[self.cursor.0].len()
    }

    fn clamp_col(&mut self) {
        let len = self.current_line_len();
        if self.cursor.1 > len {
            self.cursor.1 = len;
        }
    }

    fn ensure_visible(&mut self) {
        if self.cursor.0 < self.scroll {
            self.scroll = self.cursor.0;
        }
        if self.cursor.0 >= self.scroll + self.viewport_height {
            self.scroll = self.cursor.0 - self.viewport_height + 1;
        }
    }


    pub fn goto_line(&mut self, line: usize) {
        self.cursor.0 = line.min(self.lines.len().saturating_sub(1));
        self.clamp_col();
        self.ensure_visible();
    }

    // -----------------------------------------------------------------------
    // Rendering
    // -----------------------------------------------------------------------

    pub fn render(&mut self, frame: &mut Frame, area: Rect, is_focused: bool, theme: &Theme) {
        let filename = self.path.rsplit('/').next().unwrap_or(&self.path);
        let dirty_marker = if self.dirty { " ●" } else { "" };
        let title = format!(" {}{} — {}/{} ", filename, dirty_marker, self.cursor.0 + 1, self.lines.len());

        let block = if is_focused {
            Block::default()
                .borders(Borders::ALL)
                .border_type(BorderType::Thick)
                .border_style(Style::default().fg(theme.text))
                .title(Span::styled(
                    title,
                    Style::default()
                        .fg(Color::White)
                        .bg(theme.text)
                        .add_modifier(Modifier::BOLD),
                ))
                .title_bottom(Span::styled(
                    " Ctrl+S save │ C-↑↓ jump │ C-←→ word │ C-D del line │ Esc unfocus ",
                    Style::default().fg(theme.text_muted),
                ))
        } else {
            Block::default()
                .borders(Borders::ALL)
                .border_style(Style::default().fg(theme.border))
                .title(Span::styled(
                    title,
                    Style::default().fg(theme.text_muted).add_modifier(Modifier::BOLD),
                ))
                .title_bottom(Span::styled(
                    " Ctrl+F / Tab focus editor ",
                    Style::default().fg(theme.text_muted),
                ))
        };

        let inner = block.inner(area);
        frame.render_widget(block, area);

        if inner.height == 0 || inner.width == 0 {
            return;
        }

        self.viewport_height = inner.height as usize;
        let gutter_w = format!("{}", self.lines.len()).len() as u16 + 3; // " 123 │ "
        let content_w = inner.width.saturating_sub(gutter_w) as usize;

        let visible = inner.height as usize;
        let start = self.scroll;
        let end = (start + visible).min(self.lines.len());

        // Compute syntax highlight spans for visible lines.
        let hl_spans = highlight::highlight_range(&self.lines, start, end, self.lang);

        for (i, line_idx) in (start..end).enumerate() {
            let y = inner.y + i as u16;
            let is_cursor_line = line_idx == self.cursor.0;

            // Gutter
            let gutter = format!("{:>width$} │ ", line_idx + 1, width = (gutter_w - 3) as usize);
            let gutter_style = if is_cursor_line {
                Style::default().fg(theme.amber)
            } else {
                Style::default().fg(theme.text_muted)
            };
            frame.buffer_mut().set_string(inner.x, y, &gutter, gutter_style);

            // Line content — render with syntax highlighting.
            let line = &self.lines[line_idx];
            let base_fg = theme.text;
            let content_x = inner.x + gutter_w;

            // Build a per-char colour array for the visible portion of the line.
            let chars: Vec<char> = line.chars().take(content_w).collect();
            let n = chars.len();

            // Default colour for every char position.
            let mut colours: Vec<Color> = vec![base_fg; n];

            // Apply highlight spans (byte-indexed → char-indexed).
            // We need byte→char offset mapping because spans use byte offsets.
            let byte_to_char: Vec<usize> = {
                let mut map = vec![0usize; line.len() + 1];
                let mut ci = 0usize;
                for (bi, _) in line.char_indices() {
                    map[bi] = ci;
                    ci += 1;
                }
                map[line.len()] = ci;
                map
            };

            if let Some(spans) = hl_spans.get(i) {
                for sp in spans {
                    let cs = byte_to_char.get(sp.start).copied().unwrap_or(0);
                    let ce = byte_to_char.get(sp.end).copied().unwrap_or(n).min(n);
                    for ci in cs..ce {
                        colours[ci] = sp.color;
                    }
                }
            }

            // Render character by character.
            for (ci, &ch) in chars.iter().enumerate() {
                let sx = content_x + ci as u16;
                if sx >= inner.x + inner.width { break; }
                let style = Style::default().fg(colours[ci]);
                frame.buffer_mut().set_string(sx, y, &ch.to_string(), style);
            }
            // Pad remainder with spaces (clear any leftover content).
            for cx in n..content_w {
                let sx = content_x + cx as u16;
                if sx >= inner.x + inner.width { break; }
                frame.buffer_mut().set_string(sx, y, " ", Style::default());
            }

            // Cursor — draw on top.
            if is_cursor_line {
                let cursor_x = content_x + self.cursor.1 as u16;
                if cursor_x < inner.x + inner.width {
                    let cursor_char = line.chars().nth(self.cursor.1).unwrap_or(' ');
                    frame.buffer_mut().set_string(
                        cursor_x,
                        y,
                        &cursor_char.to_string(),
                        Style::default().bg(theme.text).fg(Color::White),
                    );
                }
            }
        }

        // Scrollbar
        if self.lines.len() > visible {
            let mut scrollbar_state =
                ScrollbarState::new(self.lines.len()).position(self.scroll);
            frame.render_stateful_widget(
                Scrollbar::new(ScrollbarOrientation::VerticalRight),
                inner,
                &mut scrollbar_state,
            );
        }
    }
}
