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
use ratatui::widgets::{Block, Borders, Scrollbar, ScrollbarOrientation, ScrollbarState};

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
    /// Viewport width for content area (set on render)
    viewport_width: usize,
    /// Horizontal scroll offset (first visible column)
    pub scroll_x: usize,
    /// Detected language for syntax highlighting
    lang: Lang,
    /// AI prompt bar is open (user is typing an instruction)
    pub prompt_open: bool,
    /// Current text in the AI prompt bar
    pub prompt_input: String,
    /// AI is currently processing a request
    pub ai_working: bool,
    /// Status message from last AI operation
    pub ai_status: Option<String>,
    /// Soft word-wrap: when true, long lines flow onto multiple visual rows
    /// instead of being clipped (and horizontal scroll is disabled).
    pub wrap: bool,
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
            viewport_width: 80,
            scroll_x: 0,
            lang: Lang::Generic,
            prompt_open: false,
            prompt_input: String::new(),
            ai_working: false,
            ai_status: None,
            wrap: true,
        }
    }

    /// Toggle soft word-wrap. Returns the new state.
    pub fn toggle_wrap(&mut self) -> bool {
        self.wrap = !self.wrap;
        if self.wrap {
            self.scroll_x = 0;
        }
        self.wrap
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
        self.scroll_x = 0;
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
    // AI prompt bar
    // -----------------------------------------------------------------------

    pub fn open_prompt(&mut self) {
        if self.ai_working { return; }
        self.prompt_open = true;
        self.prompt_input.clear();
        self.ai_status = None;
    }

    pub fn close_prompt(&mut self) {
        self.prompt_open = false;
        self.prompt_input.clear();
    }

    pub fn prompt_char(&mut self, c: char) {
        self.prompt_input.push(c);
    }

    pub fn prompt_backspace(&mut self) {
        self.prompt_input.pop();
    }

    /// Take the prompt text and mark AI as working. Returns the prompt + file path.
    pub fn submit_prompt(&mut self) -> Option<(String, String)> {
        if self.prompt_input.trim().is_empty() {
            return None;
        }
        let instruction = self.prompt_input.clone();
        let path = self.path.clone();
        self.prompt_open = false;
        self.prompt_input.clear();
        self.ai_working = true;
        self.ai_status = Some("AI working...".into());
        Some((instruction, path))
    }

    /// Reload the file from disk (after AI edits it).
    pub fn reload(&mut self) -> Result<(), String> {
        let content = std::fs::read_to_string(&self.path).map_err(|e| e.to_string())?;
        let old_cursor = self.cursor;
        self.lines = content.lines().map(|l| l.to_string()).collect();
        if self.lines.is_empty() {
            self.lines.push(String::new());
        }
        // Try to preserve cursor position
        self.cursor.0 = old_cursor.0.min(self.lines.len().saturating_sub(1));
        self.clamp_col();
        self.ensure_visible();
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
            self.ensure_visible_h();
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
            self.ensure_visible_h();
        } else if self.cursor.0 < self.lines.len() - 1 {
            self.cursor.0 += 1;
            self.cursor.1 = 0;
            self.ensure_visible();
        }
    }

    pub fn move_home(&mut self) {
        self.cursor.1 = 0;
        self.ensure_visible_h();
    }

    pub fn move_end(&mut self) {
        self.cursor.1 = self.current_line_len();
        self.ensure_visible_h();
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

    /// Scroll viewport by delta lines (positive = down, negative = up).
    /// Moves cursor to stay within the visible area.
    pub fn scroll_by(&mut self, delta: i32) {
        let max_scroll = self.lines.len().saturating_sub(self.viewport_height);
        if delta < 0 {
            self.scroll = self.scroll.saturating_sub((-delta) as usize);
        } else {
            self.scroll = (self.scroll + delta as usize).min(max_scroll);
        }
        // Keep cursor within visible range
        if self.cursor.0 < self.scroll {
            self.cursor.0 = self.scroll;
            self.clamp_col();
        } else if self.cursor.0 >= self.scroll + self.viewport_height {
            self.cursor.0 = self.scroll + self.viewport_height - 1;
            self.clamp_col();
        }
    }

    /// Jump 5 lines up (Shift+Up) — fast vertical movement.
    pub fn jump_up(&mut self) {
        self.cursor.0 = self.cursor.0.saturating_sub(5);
        self.clamp_col();
        self.ensure_visible();
    }

    /// Jump 5 lines down (Shift+Down) — fast vertical movement.
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
        self.ensure_visible_h();
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
        self.ensure_visible_h();
    }

    /// Jump to first line (Ctrl+Home).
    pub fn goto_top(&mut self) {
        self.cursor = (0, 0);
        self.scroll = 0;
        self.scroll_x = 0;
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
        self.ensure_visible_h();
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
                self.ensure_visible_h();
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
        self.ensure_visible_h();
    }

    fn ensure_visible_h(&mut self) {
        if self.wrap {
            // Word-wrap mode: no horizontal scrolling.
            self.scroll_x = 0;
            return;
        }
        let margin = 4usize; // keep cursor this far from edges
        let w = self.viewport_width;
        if w == 0 { return; }
        if self.cursor.1 < self.scroll_x + margin {
            self.scroll_x = self.cursor.1.saturating_sub(margin);
        }
        if self.cursor.1 >= self.scroll_x + w.saturating_sub(margin) {
            self.scroll_x = self.cursor.1 + margin + 1 - w;
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
        let ai_indicator = if self.ai_working { " ⟳ AI" } else { "" };
        let title = format!(" {}{}{} — {}/{} ", filename, dirty_marker, ai_indicator, self.cursor.0 + 1, self.lines.len());

        // Borderless editor — single horizontal line on top carrying the title only.
        // The global status bar handles hint text, so no bottom chrome is needed.
        let block = if is_focused {
            Block::default()
                .borders(Borders::TOP)
                .border_style(Style::default().fg(theme.text))
                .title(Span::styled(
                    title,
                    Style::default()
                        .fg(Color::White)
                        .bg(theme.text)
                        .add_modifier(Modifier::BOLD),
                ))
        } else {
            Block::default()
                .borders(Borders::TOP)
                .border_style(Style::default().fg(theme.border))
                .title(Span::styled(
                    title,
                    Style::default().fg(theme.text_muted).add_modifier(Modifier::BOLD),
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
        self.viewport_width = content_w;

        let visible = inner.height as usize;
        let start = self.scroll;
        let end = (start + visible).min(self.lines.len());

        // Compute syntax highlight spans for visible lines.
        let hl_spans = highlight::highlight_range(&self.lines, start, end, self.lang);

        let total_rows = inner.height;
        let mut row_y: u16 = 0;
        let mut line_idx = start;

        while line_idx < self.lines.len() && row_y < total_rows {
            let i = line_idx - start;
            let is_cursor_line = line_idx == self.cursor.0;

            // Build per-char colour array for the full line.
            let line = &self.lines[line_idx];
            let base_fg = theme.text;
            let content_x = inner.x + gutter_w;
            let all_chars: Vec<char> = line.chars().collect();
            let total_chars = all_chars.len();
            let mut colours: Vec<Color> = vec![base_fg; total_chars];

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
                    let ce = byte_to_char.get(sp.end).copied().unwrap_or(total_chars).min(total_chars);
                    for ci in cs..ce {
                        colours[ci] = sp.color;
                    }
                }
            }

            let cursor_line_bg = if is_cursor_line && is_focused {
                Some(Color::Indexed(236))
            } else {
                None
            };
            let gutter_style = if is_cursor_line {
                Style::default().fg(theme.amber)
            } else {
                Style::default().fg(theme.text_muted)
            };

            // Number of visual rows this logical line will occupy.
            let chunks = if self.wrap && content_w > 0 {
                if total_chars == 0 { 1 } else { (total_chars + content_w - 1) / content_w }
            } else {
                1
            };

            for chunk_i in 0..chunks {
                if row_y >= total_rows { break; }
                let y = inner.y + row_y;

                // Gutter — line number on first chunk, continuation arrow on wraps.
                if chunk_i == 0 {
                    let gutter = format!("{:>width$} │ ", line_idx + 1, width = (gutter_w - 3) as usize);
                    frame.buffer_mut().set_string(inner.x, y, &gutter, gutter_style);
                } else {
                    let gutter = format!("{:>width$} ↪ ", "", width = (gutter_w - 3) as usize);
                    frame.buffer_mut().set_string(inner.x, y, &gutter, gutter_style);
                }

                // Determine which character range is on this visual row.
                let (chunk_start, chunk_end) = if self.wrap {
                    let cs = chunk_i * content_w;
                    let ce = (cs + content_w).min(total_chars);
                    (cs, ce)
                } else {
                    let sx0 = self.scroll_x;
                    let cs = sx0.min(total_chars);
                    let ce = (sx0 + content_w).min(total_chars);
                    (cs, ce)
                };

                // Render the visible characters.
                for ci in chunk_start..chunk_end {
                    let dx = (ci - chunk_start) as u16;
                    let sx = content_x + dx;
                    if sx >= inner.x + inner.width { break; }
                    let mut style = Style::default().fg(colours[ci]);
                    if let Some(bg) = cursor_line_bg {
                        style = style.bg(bg);
                    }
                    frame.buffer_mut().set_string(sx, y, &all_chars[ci].to_string(), style);
                }
                // Pad remainder with spaces (so cursor-line bg fills the row).
                let rendered = chunk_end.saturating_sub(chunk_start);
                for cx in rendered..content_w {
                    let sx = content_x + cx as u16;
                    if sx >= inner.x + inner.width { break; }
                    let pad_style = if let Some(bg) = cursor_line_bg {
                        Style::default().bg(bg)
                    } else {
                        Style::default()
                    };
                    frame.buffer_mut().set_string(sx, y, " ", pad_style);
                }

                // Cursor — draw only if it falls inside this visual row.
                if is_cursor_line && is_focused
                    && self.cursor.1 >= chunk_start
                    && self.cursor.1 < chunk_start + content_w
                {
                    let cursor_dx = (self.cursor.1 - chunk_start) as u16;
                    let cursor_x = content_x + cursor_dx;
                    if cursor_x < inner.x + inner.width {
                        let cursor_char = all_chars.get(self.cursor.1).copied().unwrap_or(' ');
                        frame.buffer_mut().set_string(
                            cursor_x,
                            y,
                            &cursor_char.to_string(),
                            Style::default().bg(Color::White).fg(Color::Black),
                        );
                    }
                }

                row_y += 1;
            }

            line_idx += 1;
        }

        // AI prompt bar — rendered at the bottom of the editor inner area
        if self.prompt_open || self.ai_status.is_some() {
            let bar_y = inner.y + inner.height.saturating_sub(1);
            if self.prompt_open {
                let prompt_text = format!("🤖 {} ", self.prompt_input);
                let cursor_pos = inner.x + prompt_text.len() as u16;
                frame.buffer_mut().set_string(
                    inner.x, bar_y,
                    &prompt_text,
                    Style::default().fg(theme.amber).bg(Color::Black),
                );
                // Pad rest of line
                let remaining = inner.width.saturating_sub(prompt_text.len() as u16);
                for dx in 0..remaining {
                    frame.buffer_mut().set_string(
                        inner.x + prompt_text.len() as u16 + dx, bar_y,
                        " ",
                        Style::default().bg(Color::Black),
                    );
                }
                // Blinking cursor
                if cursor_pos < inner.x + inner.width {
                    frame.buffer_mut().set_string(
                        cursor_pos, bar_y, " ",
                        Style::default().bg(theme.amber).fg(Color::Black),
                    );
                }
            } else if let Some(ref status) = self.ai_status {
                let msg = format!(" {} ", status);
                frame.buffer_mut().set_string(
                    inner.x, bar_y,
                    &msg,
                    Style::default().fg(Color::Black).bg(theme.green),
                );
                let remaining = inner.width.saturating_sub(msg.len() as u16);
                for dx in 0..remaining {
                    frame.buffer_mut().set_string(
                        inner.x + msg.len() as u16 + dx, bar_y,
                        " ",
                        Style::default().bg(theme.green),
                    );
                }
            }
        }

        // Vertical scrollbar
        if self.lines.len() > visible {
            let mut scrollbar_state =
                ScrollbarState::new(self.lines.len()).position(self.scroll);
            frame.render_stateful_widget(
                Scrollbar::new(ScrollbarOrientation::VerticalRight),
                inner,
                &mut scrollbar_state,
            );
        }

        // Horizontal scrollbar
        let max_line_len = self.lines[start..end].iter().map(|l| l.chars().count()).max().unwrap_or(0);
        if max_line_len > content_w {
            let hbar_area = Rect::new(inner.x + gutter_w, inner.y, inner.width.saturating_sub(gutter_w), inner.height);
            let mut hbar_state =
                ScrollbarState::new(max_line_len).position(self.scroll_x);
            frame.render_stateful_widget(
                Scrollbar::new(ScrollbarOrientation::HorizontalBottom),
                hbar_area,
                &mut hbar_state,
            );
        }
    }
}
