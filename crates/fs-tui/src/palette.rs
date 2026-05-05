//! Command palette — a searchable overlay for running commands.

use ratatui::prelude::*;
use ratatui::widgets::{Block, Borders, Clear, Paragraph, Scrollbar, ScrollbarOrientation, ScrollbarState};

use crate::theme::Theme;

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

struct PaletteEntry {
    id: &'static str,
    label: &'static str,
    shortcut: &'static str,
    category: &'static str,
}

const COMMANDS: &[PaletteEntry] = &[
    // Agents
    PaletteEntry { id: "new",         label: "New Agent…",              shortcut: "Ctrl+N",       category: "Agents" },
    PaletteEntry { id: "new_claude",  label: "New Agent (Claude)",      shortcut: "",              category: "Agents" },
    PaletteEntry { id: "new_codex",   label: "New Agent (Codex)",       shortcut: "",              category: "Agents" },
    PaletteEntry { id: "new_copilot", label: "New Agent (Copilot)",     shortcut: "",              category: "Agents" },
    PaletteEntry { id: "new_gemini",  label: "New Agent (Gemini)",      shortcut: "",              category: "Agents" },
    PaletteEntry { id: "new_folder",  label: "New Agent in Folder…",    shortcut: "Ctrl+T",       category: "Agents" },
    PaletteEntry { id: "close",       label: "Close Agent / Editor",    shortcut: "Ctrl+W",       category: "Agents" },
    PaletteEntry { id: "rename_agent",label: "Rename Focused Agent",    shortcut: "Ctrl+R / F2",  category: "Agents" },
    PaletteEntry { id: "focus_next",  label: "Focus Next Agent",        shortcut: "Ctrl+→ / Tab", category: "Agents" },
    PaletteEntry { id: "focus_prev",  label: "Focus Previous Agent",    shortcut: "Ctrl+←",       category: "Agents" },
    // Files
    PaletteEntry { id: "open",        label: "Open File",               shortcut: "Ctrl+O",       category: "Files" },
    PaletteEntry { id: "save",        label: "Save File",               shortcut: "Ctrl+S",       category: "Files" },
    PaletteEntry { id: "focus_ed",    label: "Focus Editor",            shortcut: "Ctrl+F / Tab", category: "Files" },
    PaletteEntry { id: "tree",        label: "Toggle File Tree",        shortcut: "Ctrl+E",       category: "Files" },
    PaletteEntry { id: "diff",        label: "View Diff",               shortcut: "Ctrl+D",       category: "Files" },
    PaletteEntry { id: "deps",        label: "Inspect Deps",            shortcut: "Ctrl+I",       category: "Files" },
    PaletteEntry { id: "new_file",    label: "New File",                shortcut: "n (in tree)",   category: "Files" },
    PaletteEntry { id: "new_dir",     label: "New Folder",              shortcut: "N (in tree)",   category: "Files" },
    PaletteEntry { id: "rename_file", label: "Rename",                  shortcut: "F2 (in tree)",  category: "Files" },
    PaletteEntry { id: "delete_file", label: "Delete",                  shortcut: "x (in tree)",   category: "Files" },
    PaletteEntry { id: "dup_file",    label: "Duplicate",               shortcut: "y (in tree)",   category: "Files" },
    PaletteEntry { id: "move_file",   label: "Move File",               shortcut: "m (in tree)",   category: "Files" },
    // Search
    PaletteEntry { id: "find",           label: "Find",                    shortcut: "Ctrl+F",       category: "Search" },
    PaletteEntry { id: "find_replace",   label: "Find and Replace",        shortcut: "Ctrl+H",       category: "Search" },
    PaletteEntry { id: "goto_line",      label: "Go to Line…",             shortcut: "Ctrl+G",       category: "Search" },
    PaletteEntry { id: "goto_symbol",    label: "Go to Symbol (Outline)",  shortcut: "Ctrl+R",       category: "Search" },
    // Editor
    PaletteEntry { id: "ai_edit",        label: "AI Edit File",            shortcut: "Ctrl+A",       category: "Editor" },
    PaletteEntry { id: "toggle_focus",   label: "Toggle Editor Focus Mode",shortcut: "Ctrl+B",       category: "Editor" },
    PaletteEntry { id: "toggle_wrap",    label: "Toggle Word Wrap",        shortcut: "Alt+Z",        category: "Editor" },
    PaletteEntry { id: "select_line",    label: "Select Current Line",     shortcut: "Ctrl+L",       category: "Editor" },
    PaletteEntry { id: "del_line",       label: "Delete Line",             shortcut: "Ctrl+D",       category: "Editor" },
    PaletteEntry { id: "dup_line",       label: "Duplicate Line",          shortcut: "Ctrl+Shift+D", category: "Editor" },
    PaletteEntry { id: "move_line_up",   label: "Move Line Up",            shortcut: "Alt+↑",        category: "Editor" },
    PaletteEntry { id: "move_line_down", label: "Move Line Down",          shortcut: "Alt+↓",        category: "Editor" },
    PaletteEntry { id: "copy_sel",       label: "Copy Selection",          shortcut: "Ctrl+C",       category: "Editor" },
    PaletteEntry { id: "cut_sel",        label: "Cut Selection",           shortcut: "Ctrl+X",       category: "Editor" },
    PaletteEntry { id: "paste",          label: "Paste",                   shortcut: "Ctrl+V",       category: "Editor" },
    // Multi-cursor
    PaletteEntry { id: "cursor_above",    label: "Add Cursor Above",       shortcut: "Ctrl+Alt+↑",  category: "Multi-cursor" },
    PaletteEntry { id: "cursor_below",    label: "Add Cursor Below",       shortcut: "Ctrl+Alt+↓",  category: "Multi-cursor" },
    PaletteEntry { id: "add_next_occ",    label: "Add Next Occurrence",    shortcut: "Alt+D",        category: "Multi-cursor" },
    PaletteEntry { id: "add_prev_occ",    label: "Add Prev Occurrence",    shortcut: "Alt+Shift+D",  category: "Multi-cursor" },
    PaletteEntry { id: "add_all_occ",     label: "Add All Occurrences",    shortcut: "Alt+Shift+L",  category: "Multi-cursor" },
    PaletteEntry { id: "skip_occ",        label: "Skip Current Occurrence",shortcut: "Alt+S",        category: "Multi-cursor" },
    PaletteEntry { id: "remove_last_cursor", label: "Remove Last Cursor",  shortcut: "Alt+Backspace",category: "Multi-cursor" },
    // Folding
    PaletteEntry { id: "toggle_fold",    label: "Toggle Fold at Cursor",  shortcut: "Alt+[",        category: "Folding" },
    PaletteEntry { id: "fold_all",       label: "Fold All",               shortcut: "Alt+Shift+[",  category: "Folding" },
    PaletteEntry { id: "unfold_all",     label: "Unfold All",             shortcut: "Alt+Shift+]",  category: "Folding" },
    // Diagnostics
    PaletteEntry { id: "next_diagnostic",   label: "Next Diagnostic",        shortcut: "F8",           category: "Diagnostics" },
    PaletteEntry { id: "prev_diagnostic",   label: "Previous Diagnostic",    shortcut: "Shift+F8",     category: "Diagnostics" },
    PaletteEntry { id: "toggle_diagnostics",label: "Toggle Diagnostics",     shortcut: "Ctrl+Shift+M", category: "Diagnostics" },
    // Tabs
    PaletteEntry { id: "next_tab",       label: "Next Tab",               shortcut: "Ctrl+Tab",     category: "Tabs" },
    PaletteEntry { id: "prev_tab",       label: "Previous Tab",           shortcut: "Ctrl+Shift+Tab",category: "Tabs" },
    PaletteEntry { id: "close_tab",      label: "Close Tab",              shortcut: "Ctrl+W",       category: "Tabs" },
    // Navigation
    PaletteEntry { id: "word_left",      label: "Word Left",              shortcut: "Ctrl+←",       category: "Navigation" },
    PaletteEntry { id: "word_right",     label: "Word Right",             shortcut: "Ctrl+→",       category: "Navigation" },
    PaletteEntry { id: "goto_top",       label: "Go to Top of File",      shortcut: "Ctrl+Home",    category: "Navigation" },
    PaletteEntry { id: "goto_end",       label: "Go to End of File",      shortcut: "Ctrl+End",     category: "Navigation" },
    PaletteEntry { id: "jump_up",        label: "Jump 5 Lines Up",        shortcut: "Shift+↑",      category: "Navigation" },
    PaletteEntry { id: "jump_down",      label: "Jump 5 Lines Down",      shortcut: "Shift+↓",      category: "Navigation" },
    // View
    PaletteEntry { id: "sidebar",        label: "Toggle Sidebar",         shortcut: "Ctrl+E",       category: "View" },
    PaletteEntry { id: "copy_terminal",  label: "Copy Terminal Text",     shortcut: "Ctrl+Shift+C", category: "View" },
    PaletteEntry { id: "palette",        label: "Toggle Command Palette", shortcut: "Ctrl+K",       category: "View" },
    PaletteEntry { id: "scroll_up",      label: "Scroll Terminal Up",     shortcut: "Shift+↑",      category: "View" },
    PaletteEntry { id: "scroll_dn",      label: "Scroll Terminal Down",   shortcut: "Shift+↓",      category: "View" },
    // App
    PaletteEntry { id: "quit",           label: "Quit",                   shortcut: "Ctrl+Q",       category: "App" },
];

// ---------------------------------------------------------------------------
// Palette state
// ---------------------------------------------------------------------------

pub struct Palette {
    open: bool,
    input: String,
    selected: usize,
    /// Scroll offset — kept in sync with selection
    scroll: usize,
    /// Cached visible height from last render
    visible_height: usize,
}

impl Palette {
    pub fn new() -> Self {
        Self { open: false, input: String::new(), selected: 0, scroll: 0, visible_height: 10 }
    }

    pub fn is_open(&self) -> bool { self.open }

    pub fn toggle(&mut self) {
        if self.open { self.close(); } else {
            self.open = true;
            self.input.clear();
            self.selected = 0;
            self.scroll = 0;
        }
    }

    pub fn close(&mut self) {
        self.open = false;
        self.input.clear();
    }

    pub fn input(&mut self, c: char) {
        self.input.push(c);
        self.selected = 0;
        self.scroll = 0;
    }

    pub fn backspace(&mut self) {
        self.input.pop();
        self.selected = 0;
        self.scroll = 0;
    }

    pub fn move_selection(&mut self, delta: i32) {
        let filtered = self.filtered_commands();
        if filtered.is_empty() { return; }
        let new = self.selected as i32 + delta;
        self.selected = new.clamp(0, filtered.len() as i32 - 1) as usize;
        // Keep scroll in sync
        let vh = self.visible_height.max(1);
        if self.selected < self.scroll {
            self.scroll = self.selected;
        } else if self.selected >= self.scroll + vh {
            self.scroll = self.selected + 1 - vh;
        }
    }

    pub fn execute(&mut self) -> Option<String> {
        let filtered = self.filtered_commands();
        let result = filtered.get(self.selected).map(|e| e.id.to_string());
        self.close();
        result
    }

    /// Map a visual row (relative to the list area start) to a command index.
    /// Category headers are skipped. Returns true if a valid command was selected.
    pub fn click_row(&mut self, visual_row: usize) {
        let filtered = self.filtered_commands();
        let mut row = 0usize;
        let mut last_category = "";

        for (idx, entry) in filtered.iter().enumerate() {
            if entry.category != last_category {
                last_category = entry.category;
                if row >= self.scroll {
                    if row - self.scroll == visual_row {
                        return; // clicked on a category header, ignore
                    }
                }
                row += 1;
            }
            if row >= self.scroll && row - self.scroll == visual_row {
                self.selected = idx;
                return;
            }
            row += 1;
        }
    }


    fn filtered_commands(&self) -> Vec<&PaletteEntry> {
        let query = self.input.to_lowercase();
        COMMANDS
            .iter()
            .filter(|e| {
                if query.is_empty() { return true; }
                e.label.to_lowercase().contains(&query)
                    || e.shortcut.to_lowercase().contains(&query)
                    || e.category.to_lowercase().contains(&query)
            })
            .collect()
    }

    pub fn render(&mut self, frame: &mut Frame, area: Rect, theme: &Theme) {
        let w = 56u16.min(area.width.saturating_sub(4));
        let max_h = area.height.saturating_sub(4);
        let h = max_h.min(24); // taller palette
        let x = area.x + (area.width.saturating_sub(w)) / 2;
        let y = area.y + (area.height.saturating_sub(h)) / 3;

        let palette_area = Rect::new(x, y, w, h);
        frame.render_widget(Clear, palette_area);

        let block = Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(theme.text))
            .title(Span::styled(
                " Command Palette ",
                Style::default().fg(theme.text).add_modifier(Modifier::BOLD),
            ))
            .title_bottom(Span::styled(
                " ↑↓ navigate │ Enter run │ Esc close ",
                Style::default().fg(theme.text_muted),
            ));

        let inner = block.inner(palette_area);
        frame.render_widget(block, palette_area);

        if inner.height < 2 { return; }

        // Input line
        let input_area = Rect::new(inner.x, inner.y, inner.width, 1);
        let prompt = format!("❯ {}", self.input);
        frame.render_widget(
            Paragraph::new(prompt).style(Style::default().fg(theme.text)),
            input_area,
        );

        // Separator
        let sep_area = Rect::new(inner.x, inner.y + 1, inner.width, 1);
        let sep = "─".repeat(inner.width as usize);
        frame.render_widget(
            Paragraph::new(sep).style(Style::default().fg(theme.border)),
            sep_area,
        );

        // Results list area
        let list_height = (inner.height - 2) as usize; // minus input + separator
        self.visible_height = list_height;
        let filtered = self.filtered_commands();
        let total = filtered.len();
        let scroll = self.scroll;

        // Group by category — render with headers
        let list_y = inner.y + 2;
        let mut row = 0usize;
        let mut skipped = 0usize;
        let mut last_category = "";

        for (idx, entry) in filtered.iter().enumerate() {
            // Category header
            if entry.category != last_category {
                last_category = entry.category;
                // Render category header (counts as a visual row)
                if skipped >= scroll && row < list_height {
                    let ry = list_y + row as u16;
                    frame.buffer_mut().set_string(
                        inner.x,
                        ry,
                        &format!(" {} ", entry.category),
                        Style::default().fg(theme.text_muted).add_modifier(Modifier::BOLD | Modifier::UNDERLINED),
                    );
                    row += 1;
                } else {
                    skipped += 1;
                }
                if row >= list_height { break; }
            }

            if skipped < scroll {
                skipped += 1;
                continue;
            }
            if row >= list_height { break; }

            let ry = list_y + row as u16;
            let is_sel = idx == self.selected;

            let label_style = if is_sel {
                Style::default().fg(Color::Black).bg(theme.text)
            } else {
                Style::default().fg(theme.text)
            };
            let shortcut_style = if is_sel {
                Style::default().fg(Color::DarkGray).bg(theme.text)
            } else {
                Style::default().fg(theme.text_muted)
            };

            // Indicator
            let indicator = if is_sel { "▸ " } else { "  " };
            frame.buffer_mut().set_string(inner.x, ry, indicator, label_style);

            // Label
            let label_x = inner.x + 2;
            frame.buffer_mut().set_string(label_x, ry, entry.label, label_style);

            // Shortcut — right-aligned
            if !entry.shortcut.is_empty() {
                let sc_len = entry.shortcut.len() as u16;
                let sc_x = (inner.x + inner.width).saturating_sub(sc_len + 1);
                frame.buffer_mut().set_string(sc_x, ry, entry.shortcut, shortcut_style);
            }

            // Fill gaps with selection background if selected
            if is_sel {
                let label_end = label_x + entry.label.len() as u16;
                let sc_start = if entry.shortcut.is_empty() {
                    inner.x + inner.width
                } else {
                    (inner.x + inner.width).saturating_sub(entry.shortcut.len() as u16 + 1)
                };
                for fx in label_end..sc_start {
                    frame.buffer_mut().set_string(fx, ry, " ", label_style);
                }
            }

            row += 1;
        }

        // Scrollbar if needed
        if total > list_height {
            let sb_area = Rect::new(inner.x, list_y, inner.width, list_height as u16);
            let mut sb_state = ScrollbarState::new(total).position(scroll);
            frame.render_stateful_widget(
                Scrollbar::new(ScrollbarOrientation::VerticalRight),
                sb_area,
                &mut sb_state,
            );
        }
    }
}
