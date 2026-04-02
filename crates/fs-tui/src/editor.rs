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
        }
    }

    pub fn is_open(&self) -> bool {
        self.open
    }

    /// Open a file for editing.
    pub fn open_file(&mut self, path: &str) -> Result<(), String> {
        let content = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
        self.path = path.to_string();
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

    // -----------------------------------------------------------------------
    // Editing
    // -----------------------------------------------------------------------

    pub fn insert_char(&mut self, c: char) {
        let col = self.cursor.1.min(self.lines[self.cursor.0].len());
        self.lines[self.cursor.0].insert(col, c);
        self.cursor.1 = col + 1;
        self.dirty = true;
    }

    pub fn insert_newline(&mut self) {
        let line = self.cursor.0;
        let col = self.cursor.1.min(self.lines[line].len());
        let rest = self.lines[line][col..].to_string();
        self.lines[line].truncate(col);
        self.lines.insert(line + 1, rest);
        self.cursor.0 += 1;
        self.cursor.1 = 0;
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

    pub fn line_count(&self) -> usize {
        self.lines.len()
    }

    // -----------------------------------------------------------------------
    // Rendering
    // -----------------------------------------------------------------------

    pub fn render(&mut self, frame: &mut Frame, area: Rect) {
        let filename = self.path.rsplit('/').next().unwrap_or(&self.path);
        let dirty_marker = if self.dirty { " ●" } else { "" };
        let title = format!(" {}{} — {}/{} ", filename, dirty_marker, self.cursor.0 + 1, self.lines.len());

        let block = Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(Color::Magenta))
            .title(Span::styled(
                title,
                Style::default()
                    .fg(Color::Magenta)
                    .add_modifier(Modifier::BOLD),
            ))
            .title_bottom(Span::styled(
                " Ctrl+S save │ ↑↓←→ navigate │ Esc close ",
                Style::default().fg(Color::DarkGray),
            ));

        let inner = block.inner(area);
        frame.render_widget(block, area);

        if inner.height == 0 || inner.width == 0 {
            return;
        }

        self.viewport_height = inner.height as usize;
        let gutter_w = format!("{}", self.lines.len()).len() as u16 + 3; // " 123 │ "
        let content_w = inner.width.saturating_sub(gutter_w);

        let visible = inner.height as usize;
        let start = self.scroll;
        let end = (start + visible).min(self.lines.len());

        for (i, line_idx) in (start..end).enumerate() {
            let y = inner.y + i as u16;
            let is_cursor_line = line_idx == self.cursor.0;

            // Gutter
            let gutter = format!("{:>width$} │ ", line_idx + 1, width = (gutter_w - 3) as usize);
            let gutter_style = if is_cursor_line {
                Style::default().fg(Color::Yellow)
            } else {
                Style::default().fg(Color::DarkGray)
            };
            frame.buffer_mut().set_string(inner.x, y, &gutter, gutter_style);

            // Line content
            let line = &self.lines[line_idx];
            let display: String = line.chars().skip(0).take(content_w as usize).collect();

            let line_style = if is_cursor_line {
                Style::default().fg(Color::White)
            } else {
                Style::default().fg(Color::Gray)
            };
            frame.buffer_mut().set_string(inner.x + gutter_w, y, &display, line_style);

            // Cursor
            if is_cursor_line {
                let cursor_x = inner.x + gutter_w + self.cursor.1 as u16;
                if cursor_x < inner.x + inner.width {
                    let cursor_char = line
                        .chars()
                        .nth(self.cursor.1)
                        .unwrap_or(' ');
                    frame.buffer_mut().set_string(
                        cursor_x,
                        y,
                        &cursor_char.to_string(),
                        Style::default().bg(Color::White).fg(Color::Black),
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
