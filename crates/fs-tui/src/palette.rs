//! Command palette — a searchable overlay for running commands.

use ratatui::prelude::*;
use ratatui::widgets::{Block, Borders, Clear, List, ListItem, Paragraph};

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

struct PaletteEntry {
    id: &'static str,
    label: &'static str,
    shortcut: &'static str,
}

const COMMANDS: &[PaletteEntry] = &[
    PaletteEntry { id: "new", label: "New Agent", shortcut: "Ctrl+N" },
    PaletteEntry { id: "close", label: "Close Agent", shortcut: "Ctrl+W" },
    PaletteEntry { id: "quit", label: "Quit", shortcut: "Ctrl+Q" },
];

// ---------------------------------------------------------------------------
// Palette state
// ---------------------------------------------------------------------------

pub struct Palette {
    open: bool,
    input: String,
    selected: usize,
}

impl Palette {
    pub fn new() -> Self {
        Self {
            open: false,
            input: String::new(),
            selected: 0,
        }
    }

    pub fn is_open(&self) -> bool {
        self.open
    }

    pub fn toggle(&mut self) {
        if self.open {
            self.close();
        } else {
            self.open = true;
            self.input.clear();
            self.selected = 0;
        }
    }

    pub fn close(&mut self) {
        self.open = false;
        self.input.clear();
    }

    pub fn input(&mut self, c: char) {
        self.input.push(c);
        self.selected = 0;
    }

    pub fn backspace(&mut self) {
        self.input.pop();
        self.selected = 0;
    }

    pub fn move_selection(&mut self, delta: i32) {
        let filtered = self.filtered_commands();
        if filtered.is_empty() {
            return;
        }
        let new = self.selected as i32 + delta;
        self.selected = new.clamp(0, filtered.len() as i32 - 1) as usize;
    }

    pub fn execute(&mut self) -> Option<String> {
        let filtered = self.filtered_commands();
        let result = filtered.get(self.selected).map(|e| e.id.to_string());
        self.close();
        result
    }

    fn filtered_commands(&self) -> Vec<&PaletteEntry> {
        let query = self.input.to_lowercase();
        COMMANDS
            .iter()
            .filter(|e| query.is_empty() || e.label.to_lowercase().contains(&query))
            .collect()
    }

    pub fn render(&self, frame: &mut Frame, area: Rect) {
        // Center the palette: 40 cols wide, up to 10 rows tall
        let w = 40u16.min(area.width.saturating_sub(4));
        let h = 10u16.min(area.height.saturating_sub(4));
        let x = area.x + (area.width.saturating_sub(w)) / 2;
        let y = area.y + (area.height.saturating_sub(h)) / 3; // slightly above center

        let palette_area = Rect::new(x, y, w, h);

        // Clear background
        frame.render_widget(Clear, palette_area);

        let block = Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(Color::Cyan))
            .title(Span::styled(
                " Command Palette ",
                Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD),
            ));

        let inner = block.inner(palette_area);
        frame.render_widget(block, palette_area);

        if inner.height < 2 {
            return;
        }

        // Input line
        let input_area = Rect::new(inner.x, inner.y, inner.width, 1);
        let prompt = format!("❯ {}", self.input);
        frame.render_widget(
            Paragraph::new(prompt).style(Style::default().fg(Color::White)),
            input_area,
        );

        // Results list
        let list_area = Rect::new(inner.x, inner.y + 1, inner.width, inner.height - 1);
        let filtered = self.filtered_commands();

        let items: Vec<ListItem> = filtered
            .iter()
            .enumerate()
            .map(|(i, entry)| {
                let style = if i == self.selected {
                    Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD)
                } else {
                    Style::default().fg(Color::White)
                };
                let line = Line::from(vec![
                    Span::styled(
                        if i == self.selected { "▸ " } else { "  " },
                        style,
                    ),
                    Span::styled(entry.label, style),
                    Span::styled(
                        format!("  {}", entry.shortcut),
                        Style::default().fg(Color::DarkGray),
                    ),
                ]);
                ListItem::new(line)
            })
            .collect();

        frame.render_widget(List::new(items), list_area);
    }
}
