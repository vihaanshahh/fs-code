//! Main application state and event loop.

use std::collections::HashMap;
use std::io;
use std::path::Path;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use alacritty_terminal::grid::Dimensions;
use crossterm::event::{self, Event, KeyCode, KeyEvent, KeyboardEnhancementFlags, KeyModifiers, MouseEvent, MouseEventKind, PushKeyboardEnhancementFlags, PopKeyboardEnhancementFlags, EnableBracketedPaste, DisableBracketedPaste};
use crossterm::terminal::{self, EnterAlternateScreen, LeaveAlternateScreen};
use crossterm::event::{DisableMouseCapture, EnableMouseCapture};
use crossterm::ExecutableCommand;
use ratatui::prelude::*;
use ratatui::widgets::{Block, Borders, Clear, List, ListItem, Paragraph};

use fs_agent;
use fs_core::{uid, AgentDescriptor, AgentId, Config, KeyAction, Provider};
use fs_pty::TerminalManager;

use crate::clipboard;
use crate::deps::DepsViewer;
use crate::diff::DiffViewer;
use crate::editor::{Editor, OpenFileOutcome, PromptSubmit};
use crate::file_picker::{FilePicker, PickerMode};
use crate::file_tree::{FileTree, SIDEBAR_WIDTH};
use crate::grid;
use crate::palette::Palette;
use crate::render;
use crate::theme::{self, Theme, ThemeMode};

// ---------------------------------------------------------------------------
// Pane text selection — click-and-drag in agent terminal panes
// ---------------------------------------------------------------------------

/// A text selection within an agent terminal pane, in screen coordinates.
#[derive(Debug, Clone, Copy)]
pub(crate) struct PaneSelection {
    /// Agent index this selection belongs to
    agent_idx: usize,
    /// Start position (row, col) relative to the pane inner area
    start: (usize, usize),
    /// End position (row, col) relative to the pane inner area
    end: (usize, usize),
}

impl PaneSelection {
    /// Return (start, end) normalized so start <= end in reading order.
    fn ordered(&self) -> ((usize, usize), (usize, usize)) {
        if self.start.0 < self.end.0
            || (self.start.0 == self.end.0 && self.start.1 <= self.end.1)
        {
            (self.start, self.end)
        } else {
            (self.end, self.start)
        }
    }

    /// Check if a cell (row, col) is within the selection.
    pub(crate) fn contains(&self, row: usize, col: usize) -> bool {
        let (s, e) = self.ordered();
        if row < s.0 || row > e.0 {
            return false;
        }
        if row == s.0 && row == e.0 {
            return col >= s.1 && col <= e.1;
        }
        if row == s.0 {
            return col >= s.1;
        }
        if row == e.0 {
            return col <= e.1;
        }
        true
    }
}

// ---------------------------------------------------------------------------
// AI edit result — sent from background thread back to main loop
// ---------------------------------------------------------------------------

struct AiEditResult {
    success: bool,
    message: String,
    /// File path that was edited
    file_path: String,
    /// Original file content before AI edit (for diff)
    original_content: Option<String>,
}

// ---------------------------------------------------------------------------
// Active overlay — only one overlay can be open at a time
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq)]
enum Overlay {
    None,
    Palette,
    FilePicker,
    FolderInput,
    ProviderPicker,
    QuitConfirm,
    FileConflict,
    Editor,
    Diff,
    Deps,
    RenameAgent,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum FileOpenTarget {
    Editor,
    External,
}

enum FileOpenResult {
    Editor(OpenFileOutcome),
    External,
}

struct FileConflict {
    path: String,
    selected: usize,
}

impl FileConflict {
    fn new(path: String) -> Self {
        Self { path, selected: 0 }
    }

    fn move_selection(&mut self, delta: i32) {
        let count = FILE_CONFLICT_CHOICES.len() as i32;
        self.selected = (self.selected as i32 + delta).rem_euclid(count) as usize;
    }
}

const FILE_CONFLICT_CHOICES: &[&str] = &["Keep mine", "Reload disk", "Show diff"];

// ---------------------------------------------------------------------------
// Provider picker — small popup for choosing which agent to spawn
// ---------------------------------------------------------------------------

const PROVIDER_CHOICES: &[Provider] = &[Provider::Claude, Provider::Codex, Provider::Copilot, Provider::Gemini, Provider::Terminal];

struct ProviderPicker {
    selected: usize,
    /// If Some(cwd), the picker is opening an agent in a specific folder
    /// (from Ctrl+Shift+N flow). Otherwise uses the current cwd.
    target_cwd: Option<String>,
}

impl ProviderPicker {
    fn new() -> Self {
        Self { selected: 0, target_cwd: None }
    }

    fn open(&mut self, target_cwd: Option<String>) {
        self.selected = 0;
        self.target_cwd = target_cwd;
    }

    fn move_selection(&mut self, delta: i32) {
        let n = PROVIDER_CHOICES.len() as i32;
        let new = (self.selected as i32 + delta).rem_euclid(n);
        self.selected = new as usize;
    }

    fn current(&self) -> Provider {
        PROVIDER_CHOICES[self.selected]
    }

    fn render(&self, frame: &mut Frame, area: Rect, theme: &Theme) {
        let w = 40u16.min(area.width.saturating_sub(4));
        let h = (PROVIDER_CHOICES.len() as u16 + 4).min(area.height.saturating_sub(4));
        let x = area.x + (area.width.saturating_sub(w)) / 2;
        let y = area.y + (area.height.saturating_sub(h)) / 2;

        let picker_area = Rect::new(x, y, w, h);
        frame.render_widget(Clear, picker_area);

        let block = Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(theme.text))
            .title(Span::styled(
                " New Agent ",
                Style::default().fg(theme.text).add_modifier(Modifier::BOLD),
            ));

        let inner = block.inner(picker_area);
        frame.render_widget(block, picker_area);

        if inner.height < 2 {
            return;
        }

        let items: Vec<ListItem> = PROVIDER_CHOICES
            .iter()
            .enumerate()
            .map(|(i, p)| {
                let is_selected = i == self.selected;
                let (prefix, style) = if is_selected {
                    ("▸ ", Style::default().fg(theme.text).add_modifier(Modifier::BOLD | Modifier::REVERSED))
                } else {
                    ("  ", Style::default().fg(theme.text))
                };
                let label = format!("{}. {}", i + 1, p.label());
                ListItem::new(Line::from(vec![
                    Span::styled(prefix, style),
                    Span::styled(label, style),
                ]))
            })
            .collect();

        frame.render_widget(List::new(items), inner);
    }
}

// ---------------------------------------------------------------------------
// Folder input — simple path text field for picking a directory
// ---------------------------------------------------------------------------

struct FolderInput {
    input: String,
    error: Option<String>,
}

impl FolderInput {
    fn new() -> Self {
        Self { input: String::new(), error: None }
    }

    fn open(&mut self, initial: &str) {
        self.input = initial.to_string();
        self.error = None;
    }

    fn close(&mut self) {
        self.input.clear();
        self.error = None;
    }

    fn input_char(&mut self, c: char) {
        self.input.push(c);
        self.error = None;
    }

    fn backspace(&mut self) {
        self.input.pop();
        self.error = None;
    }

    /// Tab-complete: find the longest common prefix among matching directory entries.
    fn tab_complete(&mut self) {
        let path = std::path::Path::new(&self.input);
        let (dir, prefix) = if self.input.ends_with('/') || self.input.ends_with(std::path::MAIN_SEPARATOR) {
            (std::path::Path::new(&self.input), "")
        } else {
            let parent = path.parent().unwrap_or(std::path::Path::new("/"));
            let file = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            (parent, file)
        };

        let Ok(entries) = std::fs::read_dir(dir) else { return };
        let matches: Vec<String> = entries
            .filter_map(|e| e.ok())
            .filter(|e| e.path().is_dir())
            .filter_map(|e| {
                let name = e.file_name().to_string_lossy().to_string();
                if name.starts_with(prefix) { Some(name) } else { None }
            })
            .collect();

        if matches.is_empty() { return; }

        if matches.len() == 1 {
            let completed = dir.join(&matches[0]).to_string_lossy().to_string();
            self.input = if completed.ends_with('/') { completed } else { format!("{}/", completed) };
        } else {
            // Find longest common prefix
            let first = &matches[0];
            let common_len = first.len().min(
                matches.iter().skip(1).map(|m| {
                    first.chars().zip(m.chars()).take_while(|(a, b)| a == b).count()
                }).min().unwrap_or(first.len())
            );
            let common = &first[..common_len];
            self.input = dir.join(common).to_string_lossy().to_string();
        }
    }

    /// Validate and return the path if it's a valid directory.
    fn confirm(&mut self) -> Option<String> {
        let expanded = if self.input.starts_with('~') {
            if let Ok(home) = std::env::var("HOME") {
                self.input.replacen('~', &home, 1)
            } else {
                self.input.clone()
            }
        } else {
            self.input.clone()
        };

        let path = std::path::Path::new(&expanded);
        if path.is_dir() {
            Some(expanded)
        } else {
            self.error = Some("Not a valid directory".into());
            None
        }
    }

    fn render(&self, frame: &mut ratatui::Frame, area: Rect, theme: &Theme) {
        use ratatui::widgets::{Block, Borders, Clear, Paragraph};

        let w = 60u16.min(area.width.saturating_sub(4));
        let h = 5u16;
        let x = area.x + (area.width.saturating_sub(w)) / 2;
        let y = area.y + (area.height.saturating_sub(h)) / 3;

        let dialog_area = Rect::new(x, y, w, h);
        frame.render_widget(Clear, dialog_area);

        let block = Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(theme.text))
            .title(Span::styled(
                " New Agent — Enter folder path ",
                Style::default().fg(theme.text).add_modifier(Modifier::BOLD),
            ));

        let inner = block.inner(dialog_area);
        frame.render_widget(block, dialog_area);

        if inner.height < 2 { return; }

        // Input line
        let prompt = format!("❯ {}", self.input);
        frame.render_widget(
            Paragraph::new(prompt).style(Style::default().fg(theme.text)),
            Rect::new(inner.x, inner.y, inner.width, 1),
        );

        // Error or hint
        let hint_area = Rect::new(inner.x, inner.y + 1, inner.width, 1);
        if let Some(ref err) = self.error {
            frame.render_widget(
                Paragraph::new(err.as_str()).style(Style::default().fg(theme.red)),
                hint_area,
            );
        } else {
            frame.render_widget(
                Paragraph::new("Tab to complete · Enter to confirm · Esc to cancel")
                    .style(Style::default().fg(theme.text_muted)),
                hint_area,
            );
        }
    }
}

// ---------------------------------------------------------------------------
// Rename agent — short text input (≤ MAX_AGENT_NAME_LEN chars) for renaming
// the focused agent's pane label. Triggered by Ctrl+R.
// ---------------------------------------------------------------------------

const MAX_AGENT_NAME_LEN: usize = 8;

struct RenameAgent {
    input: String,
    agent_idx: usize,
}

impl RenameAgent {
    fn new() -> Self {
        Self { input: String::new(), agent_idx: 0 }
    }

    fn open(&mut self, idx: usize, current: &str) {
        self.agent_idx = idx;
        self.input = current.chars().take(MAX_AGENT_NAME_LEN).collect();
    }

    fn close(&mut self) {
        self.input.clear();
    }

    fn input_char(&mut self, c: char) {
        if c.is_control() { return; }
        if self.input.chars().count() < MAX_AGENT_NAME_LEN {
            self.input.push(c);
        }
    }

    fn backspace(&mut self) {
        self.input.pop();
    }

    fn render(&self, frame: &mut ratatui::Frame, area: Rect, theme: &Theme) {
        let w = 40u16.min(area.width.saturating_sub(4));
        let h = 5u16;
        let x = area.x + (area.width.saturating_sub(w)) / 2;
        let y = area.y + (area.height.saturating_sub(h)) / 3;

        let dialog_area = Rect::new(x, y, w, h);
        frame.render_widget(Clear, dialog_area);

        let block = Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(theme.text))
            .title(Span::styled(
                " Rename Agent (max 8) ",
                Style::default().fg(theme.text).add_modifier(Modifier::BOLD),
            ));

        let inner = block.inner(dialog_area);
        frame.render_widget(block, dialog_area);

        if inner.height < 2 { return; }

        let prompt = format!("❯ {}", self.input);
        frame.render_widget(
            Paragraph::new(prompt).style(Style::default().fg(theme.text)),
            Rect::new(inner.x, inner.y, inner.width, 1),
        );

        frame.render_widget(
            Paragraph::new("Enter to save · Esc to cancel")
                .style(Style::default().fg(theme.text_muted)),
            Rect::new(inner.x, inner.y + 1, inner.width, 1),
        );
    }
}

/// If `name` matches the auto-generated `Agent <n>` pattern, return `n`.
/// Used to skip custom-named agents during renumber-on-close and to compute
/// the next available default number for new agents.
fn parse_default_agent_number(name: &str) -> Option<u32> {
    let rest = name.strip_prefix("Agent ")?;
    rest.parse::<u32>().ok()
}

// ---------------------------------------------------------------------------
// AppState
// ---------------------------------------------------------------------------

pub struct App {
    agents: Vec<AgentDescriptor>,
    terminal_mgr: TerminalManager,
    /// Maps agent ID → terminal ID
    agent_terminals: HashMap<AgentId, String>,
    /// Maps agent ID → scroll offset (lines scrolled back from live view)
    scroll_offsets: HashMap<AgentId, usize>,
    focused: usize,
    config: Config,
    palette: Palette,
    file_picker: FilePicker,
    folder_input: FolderInput,
    provider_picker: ProviderPicker,
    rename_agent: RenameAgent,
    file_conflict: Option<FileConflict>,
    file_tree: FileTree,
    editor: Editor,
    diff_viewer: DiffViewer,
    deps_viewer: DepsViewer,
    overlay: Overlay,
    sidebar_open: bool,
    sidebar_focused: bool,
    /// Status message shown briefly in the status bar
    status_msg: Option<(String, std::time::Instant)>,
    should_quit: bool,
    theme: Theme,
    /// Editor/agent split percentage (editor gets this %, agents get the rest)
    editor_split_pct: u16,
    /// Whether we are currently dragging the editor border
    dragging_editor_border: bool,
    /// Whether we are currently drag-selecting in the editor
    dragging_editor_selection: bool,
    /// Current text selection in an agent terminal pane
    pane_selection: Option<PaneSelection>,
    /// Whether we are currently drag-selecting in an agent pane
    dragging_pane_selection: bool,
    /// Last sidebar click: (time, node_index) for double-click detection
    last_sidebar_click: Option<(Instant, usize)>,
    /// Last editor click: (time, col, row) for multi-click detection
    last_editor_click: Option<(Instant, u16, u16)>,
    /// Editor click count for double/triple-click (1=single, 2=word, 3=line)
    editor_click_count: u8,
    /// Editor focus mode — editor takes the dominant area, agents shrink to a thin sidebar
    editor_focus_mode: bool,
    /// Cached content area x-range for drag hit-testing
    content_area_x: u16,
    content_area_width: u16,
    /// Channel for receiving AI edit completion signals
    ai_rx: mpsc::Receiver<AiEditResult>,
    ai_tx: mpsc::Sender<AiEditResult>,
    last_terminal_revisions: HashMap<String, u64>,
    /// Snapshot of layout-relevant state from the last frame. Whenever
    /// any of these change (editor opens/closes, sidebar toggles, split
    /// is dragged, terminal resized, agent count changes), we re-fire
    /// `handle_resize()` so each agent's PTY follows the visible pane
    /// dimensions. Without this, Copilot/Ink keeps rendering at a stale
    /// width and our mouse coords drift relative to its layout.
    last_layout_sig: Option<(u16, u16, bool, bool, bool, u16, usize)>,
}

impl App {
    pub fn new() -> Self {
        let (ai_tx, ai_rx) = mpsc::channel();
        Self {
            agents: Vec::new(),
            terminal_mgr: TerminalManager::new(),
            agent_terminals: HashMap::new(),
            scroll_offsets: HashMap::new(),
            focused: 0,
            config: Config::default(),
            palette: Palette::new(),
            file_picker: FilePicker::new(),
            folder_input: FolderInput::new(),
            provider_picker: ProviderPicker::new(),
            rename_agent: RenameAgent::new(),
            file_conflict: None,
            file_tree: FileTree::new(),
            editor: Editor::new(),
            diff_viewer: DiffViewer::new(),
            deps_viewer: DepsViewer::new(),
            overlay: Overlay::None,
            sidebar_open: false,
            sidebar_focused: false,
            status_msg: None,
            should_quit: false,
            theme: theme::theme(ThemeMode::default()),
            editor_split_pct: 45,
            dragging_editor_border: false,
            dragging_editor_selection: false,
            pane_selection: None,
            dragging_pane_selection: false,
            last_sidebar_click: None,
            last_editor_click: None,
            editor_click_count: 0,
            editor_focus_mode: false,
            content_area_x: 0,
            content_area_width: 0,
            ai_rx,
            ai_tx,
            last_terminal_revisions: HashMap::new(),
            last_layout_sig: None,
        }
    }

    /// Hash of layout-relevant state. Compared each frame to detect changes
    /// (editor opened, sidebar toggled, split dragged, agents added) that
    /// require resizing agent PTYs to match their visible pane dimensions.
    fn layout_signature(&self) -> (u16, u16, bool, bool, bool, u16, usize) {
        let (cols, rows) = terminal::size().unwrap_or((80, 24));
        (
            cols,
            rows,
            self.sidebar_open,
            self.editor.is_open(),
            self.editor_focus_mode,
            self.editor_split_pct,
            self.agents.len(),
        )
    }

    /// Called at the top of each render. If the layout signature changed
    /// since the previous frame, resize all agent PTYs.
    fn relayout_if_needed(&mut self) {
        let sig = self.layout_signature();
        if Some(sig) != self.last_layout_sig {
            let _ = self.handle_resize(0, 0);
            self.last_layout_sig = Some(sig);
        }
    }

    /// Main entry point — sets up terminal, runs event loop, restores terminal.
    pub async fn run(&mut self) -> anyhow::Result<()> {
        terminal::enable_raw_mode()?;
        io::stdout().execute(EnterAlternateScreen)?;
        io::stdout().execute(EnableMouseCapture)?;
        io::stdout().execute(EnableBracketedPaste)?;
        let supports_enhancement = terminal::supports_keyboard_enhancement().unwrap_or(false);
        if supports_enhancement {
            io::stdout().execute(PushKeyboardEnhancementFlags(
                KeyboardEnhancementFlags::DISAMBIGUATE_ESCAPE_CODES,
            ))?;
        }
        let backend = CrosstermBackend::new(io::stdout());
        let mut term = Terminal::new(backend)?;
        term.clear()?;

        let result = self.event_loop(&mut term).await;

        if supports_enhancement {
            io::stdout().execute(PopKeyboardEnhancementFlags)?;
        }
        io::stdout().execute(DisableBracketedPaste)?;
        io::stdout().execute(DisableMouseCapture)?;
        terminal::disable_raw_mode()?;
        io::stdout().execute(LeaveAlternateScreen)?;
        self.terminal_mgr.close_all();

        result
    }

    async fn event_loop(
        &mut self,
        term: &mut Terminal<CrosstermBackend<io::Stdout>>,
    ) -> anyhow::Result<()> {
        let mut needs_redraw = true;
        loop {
            needs_redraw |= self.expire_status_if_needed(Instant::now());
            needs_redraw |= self.poll_ai_results();
            needs_redraw |= self.reap_exited_terminals();
            needs_redraw |= self.sync_terminal_revisions();

            if needs_redraw {
                term.draw(|frame| self.render(frame))?;
                needs_redraw = false;
            }

            if self.should_quit {
                break;
            }

            if event::poll(Duration::from_millis(50))? {
                let ev = event::read()?;
                self.handle_event(ev)?;
                needs_redraw = true;
            }
        }
        Ok(())
    }

    fn set_status(&mut self, msg: impl Into<String>) {
        self.status_msg = Some((msg.into(), std::time::Instant::now()));
    }

    fn is_quit_shortcut(key: KeyEvent) -> bool {
        key.modifiers.contains(KeyModifiers::CONTROL)
            && matches!(key.code, KeyCode::Char('q') | KeyCode::Char('Q'))
    }

    fn request_quit_confirmation(&mut self) {
        self.overlay = Overlay::QuitConfirm;
        self.sidebar_focused = false;
        self.set_status("Press Ctrl+Q again to quit, or Esc to cancel");
    }

    fn cancel_quit_confirmation(&mut self) {
        self.overlay = Overlay::None;
        self.set_status("Quit cancelled");
    }

    fn toggle_editor_focus_mode(&mut self) {
        if !self.editor.is_open() {
            self.set_status("Open a file first to enter editor focus mode");
            return;
        }
        self.editor_focus_mode = !self.editor_focus_mode;
        if self.editor_focus_mode {
            self.set_status("Editor focus mode on — agents minimized");
        } else {
            self.set_status("Editor focus mode off");
        }
        // Resize PTYs so agent terminals adapt to their new (smaller/larger) panes.
        if let Ok((c, r)) = crossterm::terminal::size() {
            let _ = self.handle_resize(c, r);
        }
    }

    fn copy_to_system_clipboard(&self, text: &str) {
        let _ = clipboard::copy_text(text);
    }

    fn open_file_for_viewing(&mut self, path: &str) -> Result<FileOpenResult, String> {
        match file_open_target(path) {
            FileOpenTarget::External => {
                open_external_file(path)?;
                Ok(FileOpenResult::External)
            }
            FileOpenTarget::Editor => {
                match self.editor.open_file(path) {
                    Ok(outcome) => Ok(FileOpenResult::Editor(outcome)),
                    Err(editor_err) if should_fallback_to_external(path, &editor_err) => {
                        open_external_file(path)?;
                        Ok(FileOpenResult::External)
                    }
                    Err(editor_err) => Err(editor_err),
                }
            }
        }
    }

    fn open_file_from_files_ui(&mut self, path: &str) {
        match self.open_file_for_viewing(path) {
            Ok(FileOpenResult::Editor(outcome)) => {
                self.sidebar_focused = false;
                self.overlay = Overlay::Editor;
                self.handle_editor_open_outcome(path, outcome, format!("Opened {}", path));
            }
            Ok(FileOpenResult::External) => {
                self.set_status(format!("Opened {}", path));
            }
            Err(e) => self.set_status(format!("Error: {}", e)),
        }
    }

    fn handle_editor_open_outcome(
        &mut self,
        path: &str,
        outcome: OpenFileOutcome,
        opened_status: String,
    ) {
        match outcome {
            OpenFileOutcome::Opened | OpenFileOutcome::Reloaded => self.set_status(opened_status),
            OpenFileOutcome::PreservedDirty => {
                self.set_status(format!("Kept unsaved changes for {}", path));
            }
            OpenFileOutcome::PreservedDirtyWithDiskChanges => {
                self.file_conflict = Some(FileConflict::new(path.to_string()));
                self.overlay = Overlay::FileConflict;
                self.set_status("Disk changed while this file has unsaved edits");
            }
        }
    }

    /// Extract the selected text from an agent terminal pane.
    fn extract_pane_selection_text(&self, sel: &PaneSelection) -> String {
        let agent = match self.agents.get(sel.agent_idx) {
            Some(a) => a,
            None => return String::new(),
        };
        let tid = match self.agent_terminals.get(&agent.id) {
            Some(t) => t,
            None => return String::new(),
        };
        let inst = match self.terminal_mgr.get(tid) {
            Some(i) => i,
            None => return String::new(),
        };
        let scroll = self.scroll_offsets.get(&agent.id).copied().unwrap_or(0);
        let Ok(t) = inst.term.lock() else {
            return String::new();
        };
        let grid = t.grid();
        let cols = grid.columns();
        let screen_rows = grid.screen_lines();
        let (s, e) = sel.ordered();
        let mut lines = Vec::new();
        for row in s.0..=e.0 {
            // Clamp row to within the visible screen — drags that overshoot
            // the pane bottom would otherwise read off the end of the alt
            // screen (which has no scrollback to fall back on).
            let clamped_row = row.min(screen_rows.saturating_sub(1));
            let line_idx = clamped_row as i32 - scroll as i32;
            let row_ref = &grid[alacritty_terminal::index::Line(line_idx)];
            let col_start = if row == s.0 { s.1 } else { 0 };
            let col_end = if row == e.0 { e.1.min(cols.saturating_sub(1)) } else { cols.saturating_sub(1) };
            let mut line = String::new();
            for c in col_start..=col_end {
                if c >= cols { break; }
                let cell = &row_ref[alacritty_terminal::index::Column(c)];
                let ch = cell.c;
                line.push(if ch == '\0' { ' ' } else { ch });
            }
            lines.push(line.trim_end().to_string());
        }
        // Remove trailing empty lines
        while lines.last().map_or(false, |l| l.is_empty()) {
            lines.pop();
        }
        lines.join("\n")
    }

    fn paste_from_clipboard(&mut self) {
        if let Some(text) = clipboard::paste_text() {
            self.editor.insert_text(&text);
        }
    }

    fn expire_status_if_needed(&mut self, now: Instant) -> bool {
        if let Some((_, at)) = &self.status_msg {
            if now.duration_since(*at) > Duration::from_secs(3) {
                self.status_msg = None;
                return true;
            }
        }
        false
    }

    fn poll_ai_results(&mut self) -> bool {
        let mut changed = false;
        while let Ok(result) = self.ai_rx.try_recv() {
            changed = true;
            self.editor.ai_working = false;
            if result.success {
                // Read new content before reloading (for diff)
                let new_content = std::fs::read_to_string(&result.file_path).ok();

                match self.editor.reload() {
                    Ok(()) => {
                        self.editor.ai_status = Some(result.message.clone());
                        self.set_status(result.message);
                    }
                    Err(e) => {
                        self.editor.ai_status = Some(format!("Reload failed: {}", e));
                        self.set_status(format!("AI edit done but reload failed: {}", e));
                    }
                }

                // Auto-open diff viewer showing what AI changed
                if let (Some(old), Some(new)) = (result.original_content, new_content) {
                    let diff_text = crate::diff::unified_diff(&result.file_path, &old, &new);
                    if !diff_text.is_empty() {
                        self.diff_viewer.open_with(&diff_text);
                        self.overlay = Overlay::Diff;
                    }
                }
            } else {
                self.editor.ai_status = Some(result.message.clone());
                self.set_status(result.message);
            }
        }
        changed
    }

    /// Auto-close any Terminal-provider panes whose shell has exited (user
    /// typed `exit`, hit Ctrl+D, etc). AI panes are left alone — keeping a
    /// crashed agent visible is useful for reading its error output.
    /// Returns true when at least one pane was reaped (caller should redraw).
    fn reap_exited_terminals(&mut self) -> bool {
        if self.agents.is_empty() {
            return false;
        }
        let mut reap_idxs: Vec<usize> = Vec::new();
        for (i, agent) in self.agents.iter().enumerate() {
            if agent.provider != Provider::Terminal {
                continue;
            }
            let Some(tid) = self.agent_terminals.get(&agent.id) else { continue };
            let Some(inst) = self.terminal_mgr.get(tid) else { continue };
            if inst.has_exited() {
                reap_idxs.push(i);
            }
        }
        if reap_idxs.is_empty() {
            return false;
        }
        // Remove from highest index downward so earlier indices stay valid.
        for idx in reap_idxs.into_iter().rev() {
            self.remove_agent_at(idx);
        }
        self.set_status("Terminal exited");
        let (cols, rows) = terminal::size().unwrap_or((80, 24));
        self.handle_resize(cols, rows).ok();
        true
    }

    fn sync_terminal_revisions(&mut self) -> bool {
        let mut changed = false;
        self.last_terminal_revisions
            .retain(|terminal_id, _| self.terminal_mgr.get(terminal_id).is_some());

        for terminal_id in self.agent_terminals.values() {
            let Some(instance) = self.terminal_mgr.get(terminal_id) else { continue };
            let revision = instance.revision();
            let entry = self
                .last_terminal_revisions
                .entry(terminal_id.clone())
                .or_insert(0);
            if *entry != revision {
                *entry = revision;
                changed = true;
            }
        }

        changed
    }

    // -----------------------------------------------------------------------
    // Event handling
    // -----------------------------------------------------------------------

    fn handle_event(&mut self, ev: Event) -> anyhow::Result<()> {
        match ev {
            Event::Key(key) => self.handle_key(key)?,
            Event::Paste(text) => self.handle_paste(&text)?,
            Event::Resize(cols, rows) => self.handle_resize(cols, rows)?,
            Event::Mouse(mouse) => self.handle_mouse(mouse)?,
            _ => {}
        }
        Ok(())
    }

    fn handle_paste(&mut self, text: &str) -> anyhow::Result<()> {
        match self.overlay {
            Overlay::Editor => {
                if self.editor.outline_open {
                    // Paste into outline filter
                    for c in text.chars().filter(|c| *c != '\n' && *c != '\r') {
                        self.editor.outline_char(c);
                    }
                } else if self.editor.replace_open {
                    // Paste into focused replace field
                    for c in text.chars().filter(|c| *c != '\n' && *c != '\r') {
                        self.editor.replace_char(c);
                    }
                } else if self.editor.is_prompt_open() {
                    // Paste into AI prompt (strip newlines)
                    for c in text.chars().filter(|c| *c != '\n' && *c != '\r') {
                        self.editor.prompt_char(c);
                    }
                } else {
                    self.editor.insert_text(text);
                }
            }
            Overlay::Palette => {
                // Insert into palette search box (strip newlines)
                for c in text.chars().filter(|c| *c != '\n' && *c != '\r') {
                    self.palette.input(c);
                }
            }
            Overlay::QuitConfirm => {}
            Overlay::FileConflict => {}
            Overlay::FilePicker => {
                for c in text.chars().filter(|c| *c != '\n' && *c != '\r') {
                    self.file_picker.input(c);
                }
            }
            Overlay::FolderInput => {
                // Paste into folder input (strip newlines, trim whitespace)
                let cleaned = text.trim().replace('\n', "").replace('\r', "");
                for c in cleaned.chars() {
                    self.folder_input.input_char(c);
                }
            }
            Overlay::RenameAgent => {
                for c in text.chars().filter(|c| !c.is_control()) {
                    self.rename_agent.input_char(c);
                }
            }
            Overlay::None => {
                // Forward the full paste to the focused terminal as a single write
                if !self.agents.is_empty() {
                    let agent = &self.agents[self.focused];
                    if let Some(tid) = self.agent_terminals.get(&agent.id) {
                        if let Some(inst) = self.terminal_mgr.get(tid) {
                            inst.write(text.as_bytes())?;
                        }
                    }
                }
            }
            _ => {}
        }
        Ok(())
    }

    /// Check if a screen position is inside a rect.
    fn rect_contains(area: Rect, col: u16, row: u16) -> bool {
        col >= area.x && col < area.x + area.width && row >= area.y && row < area.y + area.height
    }

    fn quit_confirm_rect(area: Rect) -> Rect {
        let w = if area.width > 4 {
            50u16.min(area.width.saturating_sub(4))
        } else {
            area.width
        };
        let h = if area.height > 4 {
            7u16.min(area.height.saturating_sub(4))
        } else {
            area.height
        };
        let x = area.x + area.width.saturating_sub(w) / 2;
        let y = area.y + area.height.saturating_sub(h) / 2;
        Rect::new(x, y, w, h)
    }

    fn file_conflict_rect(area: Rect) -> Rect {
        let w = if area.width > 4 {
            72u16.min(area.width.saturating_sub(4))
        } else {
            area.width
        };
        let h = if area.height > 4 {
            11u16.min(area.height.saturating_sub(4))
        } else {
            area.height
        };
        let x = area.x + area.width.saturating_sub(w) / 2;
        let y = area.y + area.height.saturating_sub(h) / 2;
        Rect::new(x, y, w, h)
    }

    /// Compute the sidebar area (if open) for hit-testing.
    fn sidebar_rect(&self) -> Option<Rect> {
        if self.sidebar_open {
            let (_, term_rows) = terminal::size().unwrap_or((80, 24));
            let main_h = term_rows.saturating_sub(1);
            Some(Rect::new(0, 0, SIDEBAR_WIDTH, main_h))
        } else {
            None
        }
    }

    /// Compute the agent grid area (everything not used by sidebar, status
    /// bar, or editor panel), mirroring the layout in `render()`.
    fn agent_grid_area(&self) -> Rect {
        let (term_cols, term_rows) = terminal::size().unwrap_or((80, 24));
        let main_h = term_rows.saturating_sub(1);
        let sidebar_w = if self.sidebar_open { SIDEBAR_WIDTH } else { 0 };
        let content_x = sidebar_w;
        let content_w = term_cols.saturating_sub(sidebar_w);
        if self.editor.is_open() {
            if self.editor_focus_mode {
                let agent_w = ((content_w as u32 * 18 / 100) as u16).clamp(20, 36);
                let editor_w = content_w.saturating_sub(agent_w);
                Rect::new(content_x + editor_w, 0, agent_w, main_h)
            } else {
                let agent_pct = 100u16.saturating_sub(self.editor_split_pct);
                let agent_w = (content_w as u32 * agent_pct as u32 / 100) as u16;
                Rect::new(content_x, 0, agent_w, main_h)
            }
        } else {
            Rect::new(content_x, 0, content_w, main_h)
        }
    }

    /// Compute every agent pane rect with the correct sidebar/editor-split
    /// layout — the source of truth for hit-testing and selection coords.
    fn pane_rects(&self) -> Vec<Rect> {
        if self.agents.is_empty() {
            return Vec::new();
        }
        grid::compute_grid(self.agent_grid_area(), self.agents.len())
    }

    /// Compute the focused agent's pane rect.
    fn focused_pane_rect(&self) -> Option<Rect> {
        self.pane_rects().get(self.focused).copied()
    }

    fn handle_mouse(&mut self, mouse: MouseEvent) -> anyhow::Result<()> {
        // Route to active overlay first — overlays consume all mouse events
        match self.overlay {
            Overlay::Palette => return self.handle_palette_mouse(mouse),
            Overlay::FilePicker => return self.handle_picker_mouse(mouse),
            Overlay::ProviderPicker => return self.handle_provider_picker_mouse(mouse),
            Overlay::QuitConfirm => return self.handle_quit_confirm_mouse(mouse),
            Overlay::FileConflict => return self.handle_file_conflict_mouse(mouse),
            Overlay::Diff => return self.handle_diff_mouse(mouse),
            Overlay::Deps => return self.handle_deps_mouse(mouse),
            Overlay::Editor if self.editor.outline_open => return self.handle_outline_mouse(mouse),
            Overlay::RenameAgent => return Ok(()),
            _ => {}
        }

        let sidebar_area = self.sidebar_rect();
        let over_sidebar = sidebar_area.map_or(false, |a| Self::rect_contains(a, mouse.column, mouse.row));
        let over_editor = self.editor.is_open() && self.is_mouse_over_editor(mouse.column, mouse.row);

        match mouse.kind {
            // -----------------------------------------------------------------
            // Scroll
            // -----------------------------------------------------------------
            MouseEventKind::ScrollUp | MouseEventKind::ScrollDown => {
                let delta: i32 = if mouse.kind == MouseEventKind::ScrollUp { -3 } else { 3 };
                if self.overlay == Overlay::Diff {
                    if delta < 0 {
                        self.diff_viewer.scroll_up((-delta) as usize);
                    } else {
                        self.diff_viewer.scroll_down(delta as usize);
                    }
                } else if over_sidebar {
                    // Scroll the sidebar file tree
                    if let Some(sa) = sidebar_area {
                        let visible = sa.height.saturating_sub(2) as usize; // borders
                        self.file_tree.scroll_by(delta, visible);
                    }
                } else if over_editor {
                    self.editor.scroll_by(delta);
                } else if self.overlay == Overlay::Editor {
                    // Editor focused — scroll regardless of pointer position
                    self.editor.scroll_by(delta);
                } else if self.overlay == Overlay::None && !self.agents.is_empty() {
                    // Scroll hovered agent pane
                    let pane_areas = self.pane_rects();
                    let hovered = pane_areas.iter().position(|a| Self::rect_contains(*a, mouse.column, mouse.row));
                    if let Some(idx) = hovered {
                        let old_cwd = self.current_cwd();
                        self.focused = idx;
                        self.refresh_sidebar_if_cwd_changed(&old_cwd);
                    }
                    self.scroll_focused(delta);
                }
            }

            // -----------------------------------------------------------------
            // Left mouse down
            // -----------------------------------------------------------------
            MouseEventKind::Down(crossterm::event::MouseButton::Left) => {
                let shift = mouse.modifiers.contains(KeyModifiers::SHIFT);
                let alt = mouse.modifiers.contains(KeyModifiers::ALT);
                let shift_alt = shift && alt;

                // --- Block selection start (Shift+Alt in editor) ---
                if shift_alt && self.overlay == Overlay::Editor {
                    if let Some((line, col)) = self.editor.mouse_position(mouse.column, mouse.row) {
                        self.editor.block_selection = Some(crate::editor::BlockSelection::new(
                            (line, col),
                            (line, col),
                        ));
                    }
                    return Ok(());
                }

                // --- Alt+click to toggle extra cursor in editor ---
                if alt && !shift && self.overlay == Overlay::Editor {
                    if let Some((line, col)) = self.editor.mouse_position(mouse.column, mouse.row) {
                        self.editor.toggle_cursor((line, col));
                    }
                    return Ok(());
                }

                // --- Sidebar click ---
                if over_sidebar {
                    if let Some(sa) = sidebar_area {
                        // Row within inner area (skip top border)
                        let row_in_inner = mouse.row.saturating_sub(sa.y + 1) as usize;
                        if let Some(idx) = self.file_tree.click_at_row(row_in_inner) {
                            // Focus sidebar
                            self.sidebar_focused = true;
                            if self.overlay == Overlay::Editor {
                                self.overlay = Overlay::None;
                            }

                            // Double-click detection
                            let now = Instant::now();
                            if let Some((last_time, last_idx)) = self.last_sidebar_click {
                                if last_idx == idx && now.duration_since(last_time) < Duration::from_millis(300) {
                                    // Double-click: activate (open file / toggle dir)
                                    if let Some(path) = self.file_tree.activate_selected() {
                                        let path_str = path.to_string_lossy().to_string();
                                        self.open_file_from_files_ui(&path_str);
                                    }
                                    self.last_sidebar_click = None;
                                    return Ok(());
                                }
                            }
                            self.last_sidebar_click = Some((now, idx));
                        }
                    }
                    return Ok(());
                }

                // --- Editor click ---
                if over_editor && self.editor.is_open() {
                    if let Some((line, col)) = self.editor.mouse_position(mouse.column, mouse.row) {
                        // Focus editor
                        self.overlay = Overlay::Editor;
                        self.sidebar_focused = false;

                        // Multi-click detection (double-click = word select, triple = line select)
                        let now = Instant::now();
                        let same_spot = self.last_editor_click.map_or(false, |(t, lc, lr)| {
                            now.duration_since(t) < Duration::from_millis(300)
                                && lc == mouse.column && lr == mouse.row
                        });
                        if same_spot {
                            self.editor_click_count = (self.editor_click_count + 1).min(3);
                        } else {
                            self.editor_click_count = 1;
                        }
                        self.last_editor_click = Some((now, mouse.column, mouse.row));

                        match self.editor_click_count {
                            2 => {
                                // Double-click: select word
                                self.editor.select_word_at((line, col));
                            }
                            3 => {
                                // Triple-click: select line
                                self.editor.select_line_at(line);
                            }
                            _ => {
                                // Single click
                                if shift {
                                    // Shift+click extends selection
                                    self.editor.extend_selection_to((line, col));
                                } else {
                                    // Regular click places cursor, clears selection
                                    self.editor.block_selection = None;
                                    self.editor.place_cursor((line, col));
                                }
                                self.dragging_editor_selection = true;
                            }
                        }
                    }
                    return Ok(());
                }

                // --- Editor/agent border drag ---
                if self.editor.is_open() && self.content_area_width > 0 && !self.editor_focus_mode {
                    let agent_pct = 100u16.saturating_sub(self.editor_split_pct);
                    let border_x = self.content_area_x
                        + (self.content_area_width as u32 * agent_pct as u32 / 100) as u16;
                    if mouse.column >= border_x.saturating_sub(1)
                        && mouse.column <= border_x + 1
                    {
                        self.dragging_editor_border = true;
                        return Ok(());
                    }
                }

                // --- Agent pane click: focus that agent + start text selection ---
                if self.overlay == Overlay::None && !self.agents.is_empty() {
                    let pane_areas = self.pane_rects();
                    if let Some(idx) = pane_areas.iter().position(|a| Self::rect_contains(*a, mouse.column, mouse.row)) {
                        let old_cwd = self.current_cwd();
                        self.focused = idx;
                        self.sidebar_focused = false;
                        self.refresh_sidebar_if_cwd_changed(&old_cwd);

                        // Start pane text selection (position relative to pane inner area)
                        let pane = pane_areas[idx];
                        let inner_x = pane.x + 1; // border
                        let inner_y = pane.y + 1; // border
                        let row = mouse.row.saturating_sub(inner_y) as usize;
                        let col = mouse.column.saturating_sub(inner_x) as usize;
                        self.pane_selection = Some(PaneSelection {
                            agent_idx: idx,
                            start: (row, col),
                            end: (row, col),
                        });
                        self.dragging_pane_selection = true;
                    }
                }
            }

            // -----------------------------------------------------------------
            // Middle mouse down — close tab if over editor tab bar
            // -----------------------------------------------------------------
            MouseEventKind::Down(crossterm::event::MouseButton::Middle) => {
                if over_editor && self.editor.is_open() && self.editor.tab_count() > 1 {
                    // Middle-click on editor area: close current tab
                    self.editor.close_tab();
                    if !self.editor.is_open() {
                        self.overlay = Overlay::None;
                    }
                }
            }

            // -----------------------------------------------------------------
            // Left drag
            // -----------------------------------------------------------------
            MouseEventKind::Drag(crossterm::event::MouseButton::Left) => {
                let shift_alt = mouse.modifiers.contains(KeyModifiers::SHIFT)
                    && mouse.modifiers.contains(KeyModifiers::ALT);
                if shift_alt && self.overlay == Overlay::Editor && self.editor.block_selection.is_some() {
                    // Extend block selection
                    if let Some((line, col)) = self.editor.mouse_position(mouse.column, mouse.row) {
                        if let Some(ref mut bs) = self.editor.block_selection {
                            bs.cursor = (line, col);
                        }
                    }
                } else if self.dragging_editor_selection {
                    // Extend normal text selection via drag
                    if let Some((line, col)) = self.editor.mouse_position(mouse.column, mouse.row) {
                        self.editor.extend_selection_to((line, col));
                    }
                } else if self.dragging_pane_selection {
                    // Extend pane text selection via drag
                    let pane_areas = self.pane_rects();
                    if let Some(ref mut sel) = self.pane_selection {
                        if let Some(&pane) = pane_areas.get(sel.agent_idx) {
                            let inner_x = pane.x + 1;
                            let inner_y = pane.y + 1;
                            sel.end = (
                                mouse.row.saturating_sub(inner_y) as usize,
                                mouse.column.saturating_sub(inner_x) as usize,
                            );
                        }
                    }
                } else if self.dragging_editor_border && self.content_area_width > 0 {
                    let rel = mouse.column.saturating_sub(self.content_area_x);
                    let agent_pct = (rel as u32 * 100 / self.content_area_width as u32) as u16;
                    self.editor_split_pct = (100u16.saturating_sub(agent_pct)).clamp(15, 85);
                }
            }

            // -----------------------------------------------------------------
            // Left mouse up — clear all drag states
            // -----------------------------------------------------------------
            MouseEventKind::Up(crossterm::event::MouseButton::Left) => {
                let was_dragging_border = self.dragging_editor_border;
                self.dragging_editor_border = false;
                self.dragging_editor_selection = false;
                if was_dragging_border {
                    // Editor split changed — agent PTYs need to follow.
                    let _ = self.handle_resize(0, 0);
                }
                if self.dragging_pane_selection {
                    self.dragging_pane_selection = false;
                    // Auto-copy selection to clipboard on mouse up (if non-empty)
                    if let Some(ref sel) = self.pane_selection {
                        if sel.start != sel.end {
                            let text = self.extract_pane_selection_text(sel);
                            if !text.is_empty() {
                                self.copy_to_system_clipboard(&text);
                                self.set_status("Copied selection");
                            }
                        } else {
                            // Single click with no drag — clear selection
                            self.pane_selection = None;
                        }
                    }
                }
            }

            _ => {}
        }
        Ok(())
    }

    fn handle_key(&mut self, key: KeyEvent) -> anyhow::Result<()> {
        // Route to active overlay first
        match self.overlay {
            Overlay::Palette => return self.handle_palette_key(key),
            Overlay::FilePicker => return self.handle_picker_key(key),
            Overlay::FolderInput => return self.handle_folder_input_key(key),
            Overlay::ProviderPicker => return self.handle_provider_picker_key(key),
            Overlay::QuitConfirm => return self.handle_quit_confirm_key(key),
            Overlay::FileConflict => return self.handle_file_conflict_key(key),
            Overlay::Editor => return self.handle_editor_key(key),
            Overlay::Diff => return self.handle_diff_key(key),
            Overlay::Deps => return self.handle_deps_key(key),
            Overlay::RenameAgent => return self.handle_rename_agent_key(key),
            Overlay::None => {}
        }

        // Sidebar gets keys when it has focus
        if self.sidebar_focused {
            return self.handle_sidebar_key(key);
        }

        // Terminal panes (plain shell) get a near-raw key stream so all the
        // standard shell bindings work — Ctrl+W word-delete, Ctrl+R history,
        // Ctrl+L clear, Tab completion, etc. We keep a tight whitelist of
        // app-level escapes so the user is never trapped in the shell.
        if self.focused_is_terminal() && self.handle_terminal_pane_key(key)? {
            return Ok(());
        }

        // Tab into the editor when it's open but not currently focused
        if key.code == KeyCode::Tab
            && !key.modifiers.contains(KeyModifiers::CONTROL)
            && self.editor.is_open()
        {
            self.overlay = Overlay::Editor;
            return Ok(());
        }

        let action = Self::map_key(key);

        match action {
            KeyAction::Quit => self.request_quit_confirmation(),
            KeyAction::NewAgent => self.open_provider_picker(),
            KeyAction::NewAgentInFolder => {
                let cwd = self.current_cwd();
                self.folder_input.open(&cwd);
                self.overlay = Overlay::FolderInput;
            }
            KeyAction::NewAgentWithProvider(p) => self.add_agent_with_provider(p)?,
            KeyAction::CloseAgent => {
                if self.editor.is_open() {
                    // Ctrl+W closes the editor panel first, agent on next press
                    self.editor.close();
                    self.overlay = Overlay::None;
                } else {
                    self.close_focused_agent();
                }
            }
            KeyAction::FocusAgent(idx) => {
                if idx < self.agents.len() {
                    let old_cwd = self.current_cwd();
                    self.focused = idx;
                    self.refresh_sidebar_if_cwd_changed(&old_cwd);
                }
            }
            KeyAction::FocusNext => {
                if !self.agents.is_empty() {
                    let old_cwd = self.current_cwd();
                    self.focused = (self.focused + 1) % self.agents.len();
                    self.refresh_sidebar_if_cwd_changed(&old_cwd);
                }
            }
            KeyAction::FocusPrev => {
                if !self.agents.is_empty() {
                    let old_cwd = self.current_cwd();
                    self.focused =
                        (self.focused + self.agents.len() - 1) % self.agents.len();
                    self.refresh_sidebar_if_cwd_changed(&old_cwd);
                }
            }
            KeyAction::TogglePalette => {
                self.palette.toggle();
                self.overlay = if self.palette.is_open() {
                    Overlay::Palette
                } else {
                    Overlay::None
                };
            }
            KeyAction::None => {
                // Check for overlay / sidebar shortcuts before forwarding to terminal
                let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
                let shift = key.modifiers.contains(KeyModifiers::SHIFT);
                match (ctrl, shift, key.code) {
                    // Sidebar toggle — Ctrl+E
                    (true, _, KeyCode::Char('e')) => {
                        self.toggle_sidebar();
                    }
                    // Ctrl+R or F2: rename the focused agent.
                    // F2 is a fallback in case the host terminal grabs Ctrl+R
                    // (e.g. for reverse-i-search) before it reaches us.
                    (true, false, KeyCode::Char('r'))
                    | (_, _, KeyCode::F(2)) => {
                        self.open_rename_agent();
                    }
                    (true, _, KeyCode::Char('o')) => {
                        let cwd = self.current_cwd();
                        self.file_picker.open(&cwd, PickerMode::Open);
                        self.overlay = Overlay::FilePicker;
                    }
                    (true, _, KeyCode::Char('d')) => {
                        let cwd = self.current_cwd();
                        self.file_picker.open(&cwd, PickerMode::Diff);
                        self.overlay = Overlay::FilePicker;
                    }
                    // Ctrl+F: focus the editor panel (if a file is open)
                    (true, _, KeyCode::Char('f')) => {
                        if self.editor.is_open() {
                            self.overlay = Overlay::Editor;
                        }
                    }
                    // Ctrl+B: toggle editor focus mode (big editor, small agents on side)
                    (true, _, KeyCode::Char('b')) => {
                        self.toggle_editor_focus_mode();
                    }
                    // Alt+Z: toggle word wrap in the editor
                    _ if key.modifiers.contains(KeyModifiers::ALT)
                        && matches!(key.code, KeyCode::Char('z') | KeyCode::Char('Z')) =>
                    {
                        let on = self.editor.toggle_wrap();
                        self.set_status(if on { "Word wrap on" } else { "Word wrap off" });
                    }
                    // Ctrl+I: inspect deps for the open editor file (or selected sidebar file)
                    (true, _, KeyCode::Char('i')) => {
                        self.open_deps_viewer();
                    }
                    // Shift+Up/Down: scroll one line
                    (_, true, KeyCode::Up) => self.scroll_focused(-1),
                    (_, true, KeyCode::Down) => self.scroll_focused(1),
                    // Shift+PageUp/PageDown: scroll a page
                    (_, true, KeyCode::PageUp) => self.scroll_focused(-20),
                    (_, true, KeyCode::PageDown) => self.scroll_focused(20),
                    // Alt+Up/Down/PgUp/PgDn: scroll the focused chat (works in every
                    // terminal — Shift+arrows require kitty keyboard protocol which
                    // not all terminals support).
                    _ if key.modifiers.contains(KeyModifiers::ALT)
                        && matches!(key.code, KeyCode::Up) =>
                    {
                        self.scroll_focused(-1);
                    }
                    _ if key.modifiers.contains(KeyModifiers::ALT)
                        && matches!(key.code, KeyCode::Down) =>
                    {
                        self.scroll_focused(1);
                    }
                    _ if key.modifiers.contains(KeyModifiers::ALT)
                        && matches!(key.code, KeyCode::PageUp) =>
                    {
                        self.scroll_focused(-20);
                    }
                    _ if key.modifiers.contains(KeyModifiers::ALT)
                        && matches!(key.code, KeyCode::PageDown) =>
                    {
                        self.scroll_focused(20);
                    }
                    // Ctrl+Shift+W: alias for Close Agent that survives the Terminal-pane
                    // forward path (where plain Ctrl+W is reserved for shell word-delete).
                    (true, true, KeyCode::Char('w')) | (true, true, KeyCode::Char('W')) => {
                        if self.editor.is_open() {
                            self.editor.close();
                            self.overlay = Overlay::None;
                        } else {
                            self.close_focused_agent();
                        }
                    }
                    // Ctrl+Shift+C: copy selected text (or full visible terminal text)
                    (true, true, KeyCode::Char('c')) | (true, true, KeyCode::Char('C')) => {
                        // Prefer pane selection if present
                        if let Some(ref sel) = self.pane_selection {
                            if sel.start != sel.end {
                                let text = self.extract_pane_selection_text(sel);
                                if !text.is_empty() {
                                    self.copy_to_system_clipboard(&text);
                                    self.set_status("Copied selection");
                                    self.pane_selection = None;
                                }
                            }
                        } else if let Some(agent) = self.agents.get(self.focused) {
                            if let Some(tid) = self.agent_terminals.get(&agent.id) {
                                if let Some(inst) = self.terminal_mgr.get(tid) {
                                    let text = inst.visible_text();
                                    if !text.is_empty() {
                                        self.copy_to_system_clipboard(&text);
                                        self.set_status("Copied terminal text");
                                    }
                                }
                            }
                        }
                    }
                    _ => {
                        // Any regular keypress snaps back to live view and clears selection
                        if let Some(agent) = self.agents.get(self.focused) {
                            self.scroll_offsets.insert(agent.id.clone(), 0);
                        }
                        self.pane_selection = None;
                        self.forward_key_to_terminal(key)?;
                    }
                }
            }
        }
        Ok(())
    }

    /// True when the focused agent pane is a plain Terminal (shell), not an
    /// AI provider. Used to decide whether to forward keys raw to the PTY.
    fn focused_is_terminal(&self) -> bool {
        self.agents
            .get(self.focused)
            .map(|a| a.provider == Provider::Terminal)
            .unwrap_or(false)
    }

    /// Key handler for plain Terminal panes. Forwards almost every keystroke
    /// straight to the shell PTY so standard line-edit bindings (Ctrl+W,
    /// Ctrl+R, Ctrl+L, Ctrl+K, Ctrl+U, Ctrl+A/E, Tab, …) work as users
    /// expect. Returns `Ok(true)` when the key was consumed, `Ok(false)`
    /// when the caller should fall through to the normal app dispatch.
    ///
    /// Whitelisted (still routed to the app, never the shell):
    ///   * `Ctrl+Q`         — quit confirmation (universal escape)
    ///   * `Ctrl+Shift+W`   — close this Terminal pane (kills the shell)
    ///   * `Ctrl+1..9`      — focus another pane by index
    ///   * `Ctrl+←/→/↑/↓`   — focus next/prev pane
    ///   * `Ctrl+Shift+C`   — copy pane selection
    ///   * `Shift+↑/↓/PgUp/PgDn`, `Alt+↑/↓/PgUp/PgDn` — scroll the pane
    fn handle_terminal_pane_key(&mut self, key: KeyEvent) -> anyhow::Result<bool> {
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        let shift = key.modifiers.contains(KeyModifiers::SHIFT);
        let alt = key.modifiers.contains(KeyModifiers::ALT);

        // Quit — always escape-hatched
        if ctrl && matches!(key.code, KeyCode::Char('q') | KeyCode::Char('Q')) {
            return Ok(false);
        }
        // Pane navigation
        if ctrl && matches!(key.code, KeyCode::Left | KeyCode::Right | KeyCode::Up | KeyCode::Down) {
            return Ok(false);
        }
        if ctrl {
            if let KeyCode::Char(c) = key.code {
                if ('1'..='9').contains(&c) {
                    return Ok(false);
                }
            }
        }
        // Copy
        if ctrl && shift && matches!(key.code, KeyCode::Char('c') | KeyCode::Char('C')) {
            return Ok(false);
        }
        // Close pane — Ctrl+Shift+W is the keyboard escape hatch from Terminal panes
        // (plain Ctrl+W is reserved for shell word-delete).
        if ctrl && shift && matches!(key.code, KeyCode::Char('w') | KeyCode::Char('W')) {
            return Ok(false);
        }
        // Scroll keys (Shift+arrows / Alt+arrows / PgUp/PgDn variants)
        if (shift || alt)
            && matches!(
                key.code,
                KeyCode::Up | KeyCode::Down | KeyCode::PageUp | KeyCode::PageDown
            )
        {
            return Ok(false);
        }

        // Everything else goes straight to the shell. Snap back to live view
        // and clear any in-flight pane selection — same behavior as the
        // normal forward path.
        if let Some(agent) = self.agents.get(self.focused) {
            self.scroll_offsets.insert(agent.id.clone(), 0);
        }
        self.pane_selection = None;
        self.forward_key_to_terminal(key)?;
        Ok(true)
    }

    fn map_key(key: KeyEvent) -> KeyAction {
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);

        if ctrl {
            match key.code {
                KeyCode::Char('q') => return KeyAction::Quit,
                KeyCode::Char('n') => return KeyAction::NewAgent,
                KeyCode::Char('t') => return KeyAction::NewAgentInFolder,
                KeyCode::Char('w') => return KeyAction::CloseAgent,
                KeyCode::Char('k') => return KeyAction::TogglePalette,
                KeyCode::Char(c) if ('1'..='9').contains(&c) => {
                    return KeyAction::FocusAgent((c as usize) - ('1' as usize));
                }
                _ => {}
            }
        }

        if ctrl {
            match key.code {
                KeyCode::Right | KeyCode::Down => return KeyAction::FocusNext,
                KeyCode::Left | KeyCode::Up => return KeyAction::FocusPrev,
                _ => {}
            }
        }

        if key.code == KeyCode::Tab {
            return KeyAction::FocusNext;
        }

        KeyAction::None
    }

    fn forward_key_to_terminal(&self, key: KeyEvent) -> anyhow::Result<()> {
        if self.agents.is_empty() {
            return Ok(());
        }

        let agent = &self.agents[self.focused];
        let terminal_id = match self.agent_terminals.get(&agent.id) {
            Some(tid) => tid,
            None => return Ok(()),
        };
        let instance = match self.terminal_mgr.get(terminal_id) {
            Some(inst) => inst,
            None => return Ok(()),
        };

        let bytes = key_to_bytes(key);
        if !bytes.is_empty() {
            instance.write(&bytes)?;
        }
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Overlay: Palette
    // -----------------------------------------------------------------------

    fn handle_palette_key(&mut self, key: KeyEvent) -> anyhow::Result<()> {
        match key.code {
            KeyCode::Esc => {
                self.palette.close();
                self.overlay = Overlay::None;
            }
            KeyCode::Enter => {
                if let Some(cmd) = self.palette.execute() {
                    self.execute_palette_command(&cmd)?;
                }
            }
            KeyCode::Char(c) => self.palette.input(c),
            KeyCode::Backspace => self.palette.backspace(),
            KeyCode::Up => self.palette.move_selection(-1),
            KeyCode::Down => self.palette.move_selection(1),
            _ => {}
        }
        Ok(())
    }

    fn execute_palette_command(&mut self, cmd: &str) -> anyhow::Result<()> {
        self.overlay = Overlay::None;
        match cmd {
            "new" => self.open_provider_picker(),
            "new_claude" => self.add_agent_with_provider(Provider::Claude)?,
            "new_codex" => self.add_agent_with_provider(Provider::Codex)?,
            "new_copilot" => self.add_agent_with_provider(Provider::Copilot)?,
            "new_gemini" => self.add_agent_with_provider(Provider::Gemini)?,
            "new_terminal" => self.add_agent_with_provider(Provider::Terminal)?,
            "toggle_focus" => self.toggle_editor_focus_mode(),
            "toggle_wrap" => {
                let on = self.editor.toggle_wrap();
                self.set_status(if on { "Word wrap on" } else { "Word wrap off" });
            }
            "new_folder" => {
                let cwd = self.current_cwd();
                self.folder_input.open(&cwd);
                self.overlay = Overlay::FolderInput;
            }
            "close" => {
                if self.editor.is_open() {
                    self.editor.close();
                } else {
                    self.close_focused_agent();
                }
            }
            "rename_agent" => self.open_rename_agent(),
            "open" => {
                let cwd = self.current_cwd();
                self.file_picker.open(&cwd, PickerMode::Open);
                self.overlay = Overlay::FilePicker;
            }
            "save" => {
                if self.editor.is_open() {
                    match self.editor.save() {
                        Ok(()) => self.set_status("Saved"),
                        Err(e) => self.set_status(format!("Save failed: {}", e)),
                    }
                }
            }
            "focus_ed" => {
                if self.editor.is_open() {
                    self.overlay = Overlay::Editor;
                }
            }
            "focus_next" => {
                if !self.agents.is_empty() {
                    let old_cwd = self.current_cwd();
                    self.focused = (self.focused + 1) % self.agents.len();
                    self.refresh_sidebar_if_cwd_changed(&old_cwd);
                }
            }
            "focus_prev" => {
                if !self.agents.is_empty() {
                    let old_cwd = self.current_cwd();
                    self.focused = (self.focused + self.agents.len() - 1) % self.agents.len();
                    self.refresh_sidebar_if_cwd_changed(&old_cwd);
                }
            }
            "diff" => {
                let cwd = self.current_cwd();
                self.file_picker.open(&cwd, PickerMode::Diff);
                self.overlay = Overlay::FilePicker;
            }
            "deps" => {
                self.open_deps_viewer();
            }
            "tree" => {
                self.toggle_sidebar();
            }
            "new_file" => {
                self.ensure_sidebar_focused();
                self.file_tree.start_new_file();
                self.set_status("New file: type name, Enter to create, Esc to cancel");
            }
            "new_dir" => {
                self.ensure_sidebar_focused();
                self.file_tree.start_new_folder();
                self.set_status("New folder: type name, Enter to create, Esc to cancel");
            }
            "rename_file" => {
                self.ensure_sidebar_focused();
                self.file_tree.start_rename();
                self.set_status("Rename: edit name, Enter to confirm, Esc to cancel");
            }
            "delete_file" => {
                self.ensure_sidebar_focused();
                match self.file_tree.delete_selected() {
                    Ok(msg) => {
                        self.file_tree.refresh();
                        self.set_status(msg);
                    }
                    Err(e) => self.set_status(format!("Delete failed: {}", e)),
                }
            }
            "dup_file" => {
                self.ensure_sidebar_focused();
                match self.file_tree.duplicate_selected() {
                    Ok(msg) => {
                        self.file_tree.refresh();
                        self.set_status(msg);
                    }
                    Err(e) => self.set_status(format!("Duplicate failed: {}", e)),
                }
            }
            "move_file" => {
                self.ensure_sidebar_focused();
                self.file_tree.start_move();
                self.set_status("Move: navigate to destination, Enter to drop, Esc to cancel");
            }
            "ai_edit" => {
                if self.editor.is_open() {
                    self.overlay = Overlay::Editor;
                    self.editor.open_ai_prompt();
                } else {
                    self.set_status("Open a file first (Ctrl+O)");
                }
            }
            // Search
            "find" => {
                self.editor.open_search_prompt();
                self.overlay = Overlay::Editor;
            }
            "find_replace" => {
                self.editor.open_replace_bar();
                self.overlay = Overlay::Editor;
            }
            "goto_line" => {
                self.editor.open_goto_line_prompt();
                self.overlay = Overlay::Editor;
            }
            "goto_symbol" => {
                self.editor.open_outline();
                self.overlay = Overlay::Editor;
            }
            // Folding
            "toggle_fold" => { self.editor.toggle_fold_at_cursor(); }
            "fold_all" => {
                self.editor.fold_all();
                self.set_status("Folded all");
            }
            "unfold_all" => {
                self.editor.unfold_all();
                self.set_status("Unfolded all");
            }
            // Diagnostics
            "next_diagnostic" => { self.editor.next_diagnostic(); }
            "prev_diagnostic" => { self.editor.prev_diagnostic(); }
            "toggle_diagnostics" => { self.editor.toggle_diagnostics(); }
            // Tabs
            "next_tab" => { self.editor.next_tab(); }
            "prev_tab" => { self.editor.prev_tab(); }
            "close_tab" => {
                if self.editor.close_tab() {
                    self.overlay = Overlay::None;
                }
            }
            // Editor actions
            "select_line" => {
                self.editor.select_current_line();
                self.overlay = Overlay::Editor;
            }
            "copy_sel" => {
                if let Some(t) = self.editor.selected_text() {
                    self.copy_to_system_clipboard(&t);
                }
            }
            "cut_sel" => {
                if let Some(t) = self.editor.cut_selection() {
                    self.copy_to_system_clipboard(&t);
                }
            }
            "paste" => {
                self.paste_from_clipboard();
                self.overlay = Overlay::Editor;
            }
            // Multi-cursor
            "skip_occ" => {
                self.editor.skip_current_occurrence();
                self.overlay = Overlay::Editor;
            }
            "remove_last_cursor" => {
                self.editor.remove_last_cursor();
                self.overlay = Overlay::Editor;
            }
            "cursor_above" => {
                self.editor.add_cursor_above();
                self.overlay = Overlay::Editor;
            }
            "cursor_below" => {
                self.editor.add_cursor_below();
                self.overlay = Overlay::Editor;
            }
            "add_next_occ" => {
                self.editor.add_next_occurrence_cursor();
                self.overlay = Overlay::Editor;
            }
            "add_prev_occ" => {
                self.editor.add_prev_occurrence_cursor();
                self.overlay = Overlay::Editor;
            }
            "add_all_occ" => {
                self.editor.add_all_occurrence_cursors();
                self.overlay = Overlay::Editor;
            }
            "move_line_up" => {
                self.editor.move_lines_up();
                self.overlay = Overlay::Editor;
            }
            "move_line_down" => {
                self.editor.move_lines_down();
                self.overlay = Overlay::Editor;
            }
            "sidebar" => {
                self.toggle_sidebar();
            }
            "copy_terminal" => {
                if let Some(agent) = self.agents.get(self.focused) {
                    if let Some(tid) = self.agent_terminals.get(&agent.id) {
                        if let Some(inst) = self.terminal_mgr.get(tid) {
                            let text = inst.visible_text();
                            if !text.is_empty() {
                                self.copy_to_system_clipboard(&text);
                                self.set_status("Copied terminal text");
                            }
                        }
                    }
                }
            }
            "palette" => {
                // Already closing from execute()
            }
            "quit" => self.request_quit_confirmation(),
            // Editor-only commands are informational in palette
            _ => {}
        }
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Overlay: Quit Confirmation
    // -----------------------------------------------------------------------

    fn handle_quit_confirm_key(&mut self, key: KeyEvent) -> anyhow::Result<()> {
        match key.code {
            _ if Self::is_quit_shortcut(key) => self.should_quit = true,
            KeyCode::Esc | KeyCode::Char('n') | KeyCode::Char('N') => {
                self.cancel_quit_confirmation();
            }
            _ => {}
        }
        Ok(())
    }

    fn handle_file_conflict_key(&mut self, key: KeyEvent) -> anyhow::Result<()> {
        match key.code {
            KeyCode::Esc | KeyCode::Char('1') | KeyCode::Char('k') | KeyCode::Char('K') => {
                self.keep_file_conflict();
            }
            KeyCode::Char('2') | KeyCode::Char('r') | KeyCode::Char('R') => {
                self.reload_file_conflict();
            }
            KeyCode::Char('3') | KeyCode::Char('d') | KeyCode::Char('D') => {
                self.show_file_conflict_diff();
            }
            KeyCode::Left | KeyCode::Up | KeyCode::BackTab => {
                if let Some(conflict) = self.file_conflict.as_mut() {
                    conflict.move_selection(-1);
                }
            }
            KeyCode::Right | KeyCode::Down | KeyCode::Tab => {
                if let Some(conflict) = self.file_conflict.as_mut() {
                    conflict.move_selection(1);
                }
            }
            KeyCode::Enter => {
                let selected = self.file_conflict.as_ref().map(|c| c.selected).unwrap_or(0);
                match selected {
                    0 => self.keep_file_conflict(),
                    1 => self.reload_file_conflict(),
                    2 => self.show_file_conflict_diff(),
                    _ => {}
                }
            }
            _ => {}
        }
        Ok(())
    }

    fn keep_file_conflict(&mut self) {
        let path = self.file_conflict.take().map(|c| c.path).unwrap_or_else(|| self.editor.path.clone());
        self.overlay = Overlay::Editor;
        self.set_status(format!("Kept unsaved changes for {}", path));
    }

    fn reload_file_conflict(&mut self) {
        let path = self.file_conflict
            .as_ref()
            .map(|c| c.path.clone())
            .unwrap_or_else(|| self.editor.path.clone());

        match self.editor.reload() {
            Ok(()) => {
                self.file_conflict = None;
                self.overlay = Overlay::Editor;
                self.set_status(format!("Reloaded {} from disk", path));
            }
            Err(e) => {
                self.set_status(format!("Reload failed: {}", e));
            }
        }
    }

    fn show_file_conflict_diff(&mut self) {
        let path = self.file_conflict
            .as_ref()
            .map(|c| c.path.clone())
            .unwrap_or_else(|| self.editor.path.clone());

        let disk_content = match std::fs::read_to_string(&path) {
            Ok(content) => content,
            Err(e) => {
                self.set_status(format!("Could not read disk copy: {}", e));
                return;
            }
        };

        let buffer_content = self.editor.content();
        let diff_text = crate::diff::unified_diff(&path, &buffer_content, &disk_content);
        if diff_text.is_empty() {
            self.file_conflict = None;
            self.overlay = Overlay::Editor;
            self.set_status("No difference between buffer and disk");
            return;
        }

        self.file_conflict = None;
        self.diff_viewer.open_with(&diff_text);
        self.overlay = Overlay::Diff;
        self.set_status(format!("Showing buffer vs disk diff for {}", path));
    }

    // -----------------------------------------------------------------------
    // Overlay: Rename Agent
    // -----------------------------------------------------------------------

    fn open_rename_agent(&mut self) {
        if self.agents.is_empty() {
            self.set_status("No agent to rename");
            return;
        }
        let idx = self.focused;
        let current = self.agents[idx].name.clone();
        self.rename_agent.open(idx, &current);
        self.overlay = Overlay::RenameAgent;
    }

    fn handle_rename_agent_key(&mut self, key: KeyEvent) -> anyhow::Result<()> {
        match key.code {
            KeyCode::Esc => {
                self.rename_agent.close();
                self.overlay = Overlay::None;
            }
            KeyCode::Enter => {
                let new_name = self.rename_agent.input.trim().to_string();
                let idx = self.rename_agent.agent_idx;
                self.rename_agent.close();
                self.overlay = Overlay::None;
                if new_name.is_empty() {
                    self.set_status("Rename cancelled (empty name)");
                } else if idx < self.agents.len() {
                    self.agents[idx].name = new_name.clone();
                    self.set_status(format!("Renamed to {}", new_name));
                }
            }
            KeyCode::Backspace => self.rename_agent.backspace(),
            KeyCode::Char(c) => {
                // Reject any modifier-Char combo (Ctrl+R, Alt+X, etc.) so
                // the trigger key doesn't accidentally type itself, and so
                // shortcut-style keys can't mutate the name.
                let mods = key.modifiers;
                if !mods.contains(KeyModifiers::CONTROL)
                    && !mods.contains(KeyModifiers::ALT)
                {
                    self.rename_agent.input_char(c);
                }
            }
            _ => {}
        }
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Overlay: Folder Input
    // -----------------------------------------------------------------------

    fn handle_folder_input_key(&mut self, key: KeyEvent) -> anyhow::Result<()> {
        match key.code {
            KeyCode::Esc => {
                self.folder_input.close();
                self.overlay = Overlay::None;
            }
            KeyCode::Enter => {
                if let Some(path) = self.folder_input.confirm() {
                    self.folder_input.close();
                    self.provider_picker.open(Some(path));
                    self.overlay = Overlay::ProviderPicker;
                }
            }
            KeyCode::Tab => {
                self.folder_input.tab_complete();
            }
            KeyCode::Backspace => self.folder_input.backspace(),
            KeyCode::Char(c) => self.folder_input.input_char(c),
            _ => {}
        }
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Overlay: File Picker
    // -----------------------------------------------------------------------

    fn handle_picker_key(&mut self, key: KeyEvent) -> anyhow::Result<()> {
        match key.code {
            KeyCode::Esc => {
                self.file_picker.close();
                self.overlay = Overlay::None;
            }
            KeyCode::Enter => {
                if let Some((path, mode)) = self.file_picker.execute() {
                    self.overlay = Overlay::None;
                    match mode {
                        PickerMode::Open => {
                            self.open_file_from_files_ui(&path);
                        }
                        PickerMode::Diff => {
                            self.open_diff_for_file(&path);
                        }
                    }
                }
            }
            KeyCode::Char(c) => self.file_picker.input(c),
            KeyCode::Backspace => self.file_picker.backspace(),
            KeyCode::Up => self.file_picker.move_selection(-1),
            KeyCode::Down => self.file_picker.move_selection(1),
            KeyCode::PageUp => self.file_picker.move_selection(-10),
            KeyCode::PageDown => self.file_picker.move_selection(10),
            KeyCode::Home => self.file_picker.move_first(),
            KeyCode::End => self.file_picker.move_last(),
            _ => {}
        }
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Overlay: Provider Picker
    // -----------------------------------------------------------------------

    fn handle_provider_picker_key(&mut self, key: KeyEvent) -> anyhow::Result<()> {
        match key.code {
            KeyCode::Esc => {
                self.overlay = Overlay::None;
            }
            KeyCode::Up | KeyCode::Char('k') => self.provider_picker.move_selection(-1),
            KeyCode::Down | KeyCode::Char('j') => self.provider_picker.move_selection(1),
            KeyCode::Char(c @ '1'..='9') => {
                let idx = (c as usize) - ('1' as usize);
                if idx < PROVIDER_CHOICES.len() {
                    self.provider_picker.selected = idx;
                    self.confirm_provider_picker()?;
                }
            }
            KeyCode::Enter => {
                self.confirm_provider_picker()?;
            }
            _ => {}
        }
        Ok(())
    }

    fn confirm_provider_picker(&mut self) -> anyhow::Result<()> {
        let provider = self.provider_picker.current();
        let target_cwd = self.provider_picker.target_cwd.take();
        self.overlay = Overlay::None;
        match target_cwd {
            Some(cwd) => self.add_agent_in_with_provider(cwd, provider)?,
            None => self.add_agent_with_provider(provider)?,
        }
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Overlay: Editor
    // -----------------------------------------------------------------------

    fn handle_editor_key(&mut self, key: KeyEvent) -> anyhow::Result<()> {
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        let shift = key.modifiers.contains(KeyModifiers::SHIFT);
        let alt = key.modifiers.contains(KeyModifiers::ALT);

        // -----------------------------------------------------------------
        // 1. Outline overlay — consumes all keys while open
        // -----------------------------------------------------------------
        if self.editor.outline_open {
            match key.code {
                KeyCode::Esc => self.editor.close_outline(),
                KeyCode::Up => self.editor.outline_move(-1),
                KeyCode::Down => self.editor.outline_move(1),
                KeyCode::Enter => {
                    if self.editor.outline_confirm() {
                        let line = self.editor.cursor.0 + 1;
                        self.set_status(format!("Jumped to line {}", line));
                    }
                }
                KeyCode::Backspace => self.editor.outline_backspace(),
                KeyCode::Char(c) => self.editor.outline_char(c),
                _ => {}
            }
            return Ok(());
        }

        // -----------------------------------------------------------------
        // 2. Inline find/replace bar — consumes keys while open
        // -----------------------------------------------------------------
        if self.editor.replace_open {
            match key.code {
                KeyCode::Esc => self.editor.close_replace_bar(),
                KeyCode::Tab => self.editor.replace_toggle_field(),
                KeyCode::Enter if alt => {
                    let n = self.editor.replace_bar_all();
                    self.set_status(format!("Replaced {} occurrences", n));
                }
                KeyCode::Enter => {
                    self.editor.replace_bar_current();
                }
                KeyCode::F(3) if shift => { self.editor.replace_bar_prev(); }
                KeyCode::F(3) => { self.editor.replace_bar_next(); }
                KeyCode::Backspace => self.editor.replace_backspace(),
                KeyCode::Char(c) => self.editor.replace_char(c),
                _ => {}
            }
            return Ok(());
        }

        // -----------------------------------------------------------------
        // 3. Prompt bar (AI, Search, GotoLine)
        // -----------------------------------------------------------------
        if self.editor.is_prompt_open() {
            match key.code {
                KeyCode::Esc => {
                    self.editor.close_prompt();
                }
                KeyCode::Enter => {
                    if let Some(action) = self.editor.submit_prompt() {
                        match action {
                            PromptSubmit::Ai { instruction, path: file_path } => {
                                self.set_status("AI editing...");
                                self.spawn_ai_edit(instruction, file_path);
                            }
                            PromptSubmit::Search { query } => {
                                self.set_status(format!("Search: \"{}\"", query));
                            }
                            PromptSubmit::Replace { query: _, replacement: _, replaced } => {
                                self.set_status(format!("Replaced {} occurrences", replaced));
                            }
                            PromptSubmit::GotoLine { line } => {
                                self.set_status(format!("Jumped to line {}", line + 1));
                            }
                        }
                    }
                }
                KeyCode::Backspace => self.editor.prompt_backspace(),
                KeyCode::Char(c) => self.editor.prompt_char(c),
                _ => {}
            }
            return Ok(());
        }

        // -----------------------------------------------------------------
        // 4. Main editor key handling — 4-tuple match
        // -----------------------------------------------------------------
        match (ctrl, shift, alt, key.code) {
            // Esc: clear extra cursors first, then block selection, then unfocus
            (_, _, _, KeyCode::Esc) => {
                if self.editor.has_extra_cursors() {
                    self.editor.clear_extra_cursors();
                } else if self.editor.block_selection.is_some() {
                    self.editor.clear_block_selection();
                } else {
                    self.editor.ai_status = None;
                    self.overlay = Overlay::None;
                }
            }

            // --- Prompts & search ---
            (true, _, false, KeyCode::Char('a')) => self.editor.open_ai_prompt(),
            (true, _, false, KeyCode::Char('f')) => self.editor.open_search_prompt(),
            (true, _, false, KeyCode::Char('h')) => self.editor.open_replace_bar(),
            (true, _, false, KeyCode::Char('g')) => self.editor.open_goto_line_prompt(),
            (true, _, false, KeyCode::Char('l')) => self.editor.select_current_line(),
            (true, _, false, KeyCode::Char('r')) => self.editor.open_outline(),

            // --- Undo / Redo ---
            (true, false, false, KeyCode::Char('z')) => { self.editor.undo(); }
            (true, false, false, KeyCode::Char('y')) => { self.editor.redo(); }
            (true, true, false, KeyCode::Char('z')) | (true, true, false, KeyCode::Char('Z')) => { self.editor.redo(); }

            // --- Clipboard ---
            (true, false, false, KeyCode::Char('c')) => {
                if self.editor.has_selection() {
                    if let Some(text) = self.editor.selected_text() {
                        self.copy_to_system_clipboard(&text);
                        self.set_status("Copied selection");
                    }
                } else {
                    // Copy current line
                    let (line, _) = self.editor.cursor;
                    if let Some(text) = self.editor.lines_ref().get(line) {
                        let copy = format!("{}\n", text);
                        self.copy_to_system_clipboard(&copy);
                        self.set_status("Copied line");
                    }
                }
            }
            (true, false, false, KeyCode::Char('x')) => {
                if let Some(text) = self.editor.cut_selection() {
                    self.copy_to_system_clipboard(&text);
                    self.set_status("Cut selection");
                }
            }
            (true, false, false, KeyCode::Char('v')) => {
                self.paste_from_clipboard();
            }

            // --- Multi-cursor ---
            (true, false, true, KeyCode::Up) => {
                let n = self.editor.add_cursor_above();
                self.set_status(format!("{} cursors", n + 1));
            }
            (true, false, true, KeyCode::Down) => {
                let n = self.editor.add_cursor_below();
                self.set_status(format!("{} cursors", n + 1));
            }
            (false, false, true, KeyCode::Char('d')) => {
                self.editor.add_next_occurrence_cursor();
            }
            (false, true, true, KeyCode::Char('D')) | (false, true, true, KeyCode::Char('d')) => {
                self.editor.add_prev_occurrence_cursor();
            }
            (false, true, true, KeyCode::Char('L')) | (false, true, true, KeyCode::Char('l')) => {
                let n = self.editor.add_all_occurrence_cursors();
                self.set_status(format!("Added {} cursors for all occurrences", n));
            }
            (false, false, true, KeyCode::Char('s')) => {
                self.editor.skip_current_occurrence();
            }
            (false, false, true, KeyCode::Backspace) => {
                self.editor.remove_last_cursor();
            }

            // --- Line operations ---
            (false, false, true, KeyCode::Up) => { self.editor.move_lines_up(); }
            (false, false, true, KeyCode::Down) => { self.editor.move_lines_down(); }

            // --- Replace shortcuts (when replace state exists) ---
            (false, false, true, KeyCode::Enter) => {
                self.editor.replace_current_match();
            }
            (false, false, true, KeyCode::Char('r')) => {
                self.editor.replace_current_and_next();
            }
            (false, true, true, KeyCode::Char('R')) | (false, true, true, KeyCode::Char('r')) => {
                if let Some(n) = self.editor.replace_all_current() {
                    self.set_status(format!("Replaced {} occurrences", n));
                }
            }

            // --- Folding ---
            // Alt+[ → toggle fold at cursor
            (false, false, true, KeyCode::Char('[')) => self.editor.toggle_fold_at_cursor(),
            // Alt+Shift+[ = Alt+{ → fold all
            (false, true, true, KeyCode::Char('{')) | (false, false, true, KeyCode::Char('{')) => {
                self.editor.fold_all();
                self.set_status("Folded all");
            }
            // Alt+Shift+] = Alt+} → unfold all
            (false, true, true, KeyCode::Char('}')) | (false, false, true, KeyCode::Char('}')) => {
                self.editor.unfold_all();
                self.set_status("Unfolded all");
            }

            // --- Diagnostics ---
            (false, false, false, KeyCode::F(8)) => { self.editor.next_diagnostic(); }
            (false, true, false, KeyCode::F(8)) => { self.editor.prev_diagnostic(); }
            (true, true, false, KeyCode::Char('m')) | (true, true, false, KeyCode::Char('M')) => {
                self.editor.toggle_diagnostics();
            }

            // --- Tabs ---
            (true, false, false, KeyCode::Tab) => self.editor.next_tab(),
            (true, true, false, KeyCode::BackTab) | (true, true, false, KeyCode::Tab) => self.editor.prev_tab(),
            (true, false, false, KeyCode::PageDown) => self.editor.next_tab(),
            (true, false, false, KeyCode::PageUp) => self.editor.prev_tab(),
            (true, false, false, KeyCode::Char('w')) => {
                if self.editor.close_tab() {
                    self.overlay = Overlay::None;
                }
            }
            // Alt+1..9 → switch tab by number
            (false, false, true, KeyCode::Char(c @ '1'..='9')) => {
                let idx = (c as usize) - ('1' as usize);
                self.editor.switch_tab(idx);
            }

            // --- Block selection (Shift+Alt+Arrow) ---
            (false, true, true, KeyCode::Up) => self.editor.extend_block_selection_dir(-1, 0),
            (false, true, true, KeyCode::Down) => self.editor.extend_block_selection_dir(1, 0),
            (false, true, true, KeyCode::Left) => self.editor.extend_block_selection_dir(0, -1),
            (false, true, true, KeyCode::Right) => self.editor.extend_block_selection_dir(0, 1),

            // --- Selection movement (Shift only, no ctrl/alt) ---
            (false, true, false, KeyCode::Left) => self.editor.select_left(),
            (false, true, false, KeyCode::Right) => self.editor.select_right(),
            (false, true, false, KeyCode::Up) => self.editor.select_up(),
            (false, true, false, KeyCode::Down) => self.editor.select_down(),
            (false, true, false, KeyCode::Home) => self.editor.select_home(),
            (false, true, false, KeyCode::End) => self.editor.select_end(),
            (false, true, false, KeyCode::PageUp) => self.editor.select_page_up(),
            (false, true, false, KeyCode::PageDown) => self.editor.select_page_down(),

            // --- Save ---
            (true, false, false, KeyCode::Char('s')) => {
                match self.editor.save() {
                    Ok(()) => self.set_status("Saved"),
                    Err(e) => self.set_status(format!("Save failed: {}", e)),
                }
            }
            // Ctrl+Shift+D: duplicate line / Ctrl+D: delete line
            (true, true, false, KeyCode::Char('d')) | (true, true, false, KeyCode::Char('D')) => {
                self.editor.duplicate_line();
            }
            (true, false, false, KeyCode::Char('d')) => self.editor.delete_line(),

            // --- Word navigation (Ctrl+Arrow) ---
            (true, false, false, KeyCode::Left) => self.editor.word_left(),
            (true, false, false, KeyCode::Right) => self.editor.word_right(),
            (true, false, false, KeyCode::Home) => self.editor.goto_top(),
            (true, false, false, KeyCode::End) => self.editor.goto_bottom(),
            // Ctrl+Shift+Left/Right: select by word
            (true, true, false, KeyCode::Left) => self.editor.select_word_left(),
            (true, true, false, KeyCode::Right) => self.editor.select_word_right(),
            (true, true, false, KeyCode::Home) => self.editor.select_top(),
            (true, true, false, KeyCode::End) => self.editor.select_bottom(),

            // --- Search navigation ---
            (false, false, false, KeyCode::F(3)) => { self.editor.next_search_match(); }
            (false, true, false, KeyCode::F(3)) => { self.editor.prev_search_match(); }

            // --- Block selection active: typing/backspace/delete ---
            (false, false, false, KeyCode::Backspace) if self.editor.block_selection.is_some() => {
                self.editor.block_backspace();
            }
            (false, false, false, KeyCode::Delete) if self.editor.block_selection.is_some() => {
                self.editor.delete_block_selection();
            }
            (false, false, false, KeyCode::Char(c)) if self.editor.block_selection.is_some() => {
                self.editor.block_insert_char(c);
            }

            // --- Normal movement & editing ---
            (false, false, false, KeyCode::Up) => self.editor.move_up(),
            (false, false, false, KeyCode::Down) => self.editor.move_down(),
            (false, false, false, KeyCode::Left) => self.editor.move_left(),
            (false, false, false, KeyCode::Right) => self.editor.move_right(),
            (false, false, false, KeyCode::Home) => self.editor.move_home(),
            (false, false, false, KeyCode::End) => self.editor.move_end(),
            (false, false, false, KeyCode::PageUp) => self.editor.page_up(),
            (false, false, false, KeyCode::PageDown) => self.editor.page_down(),
            (false, false, false, KeyCode::Enter) => self.editor.insert_newline(),
            (false, false, false, KeyCode::Backspace) => self.editor.backspace(),
            (false, false, false, KeyCode::Delete) => self.editor.delete_char(),
            (false, false, false, KeyCode::Tab) => self.editor.insert_char('\t'),
            (false, false, false, KeyCode::Char(c)) => self.editor.insert_char(c),
            _ => {}
        }
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Overlay: Diff Viewer
    // -----------------------------------------------------------------------

    fn handle_diff_key(&mut self, key: KeyEvent) -> anyhow::Result<()> {
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        match (ctrl, key.code) {
            (_, KeyCode::Esc) | (_, KeyCode::Char('q')) => {
                self.diff_viewer.close();
                self.overlay = Overlay::None;
            }
            // Single-line scroll
            (true, KeyCode::Up) => self.diff_viewer.scroll_up(1),
            (true, KeyCode::Down) => self.diff_viewer.scroll_down(1),
            // Fast scroll (5 lines)
            (false, KeyCode::Up) | (false, KeyCode::Char('k')) => self.diff_viewer.scroll_up(5),
            (false, KeyCode::Down) | (false, KeyCode::Char('j')) => self.diff_viewer.scroll_down(5),
            (_, KeyCode::PageUp) => self.diff_viewer.scroll_up(40),
            (_, KeyCode::PageDown) => self.diff_viewer.scroll_down(40),
            (false, KeyCode::Left) | (false, KeyCode::Char('h')) => self.diff_viewer.prev_file(),
            (false, KeyCode::Right) | (false, KeyCode::Char('l')) => self.diff_viewer.next_file(),
            (false, KeyCode::Char('e')) => {
                let source_line = self.diff_viewer.current_source_line();
                let path = self.diff_viewer.diffs
                    .get(self.diff_viewer.active_file)
                    .map(|d| format!("{}/{}", self.current_cwd(), d.path));
                if let Some(path) = path {
                    self.diff_viewer.close();
                    match self.editor.open_file(&path) {
                        Ok(outcome) => {
                            self.editor.goto_line(source_line);
                            self.overlay = Overlay::Editor;
                            self.handle_editor_open_outcome(
                                &path,
                                outcome,
                                format!("Editing {} :{}", path, source_line + 1),
                            );
                        }
                        Err(e) => {
                            self.overlay = Overlay::None;
                            self.set_status(format!("Error: {}", e));
                        }
                    }
                }
            }
            _ => {}
        }
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Overlay: Deps Viewer
    // -----------------------------------------------------------------------

    fn open_deps_viewer(&mut self) {
        // Prefer the currently open editor file, then the selected sidebar file.
        let file_path = if self.editor.is_open() && !self.editor.path.is_empty() {
            Some(self.editor.path.clone())
        } else if self.sidebar_open {
            self.file_tree
                .selected_path()
                .filter(|p| !p.is_dir())
                .map(|p| p.to_string_lossy().to_string())
        } else {
            None
        };

        if let Some(path) = file_path {
            let cwd = self.current_cwd();
            self.deps_viewer.open_for(&path, &cwd);
            let broken = self.deps_viewer.broken_count();
            if broken > 0 {
                self.set_status(format!(
                    "Deps: {} imports, {} broken",
                    self.deps_viewer.imports.len(),
                    broken
                ));
            } else {
                self.set_status(format!(
                    "Deps: {} imports, {} importers",
                    self.deps_viewer.imports.len(),
                    self.deps_viewer.imported_by.len(),
                ));
            }
            self.overlay = Overlay::Deps;
        } else {
            self.set_status("No file selected — open a file or select one in the tree (Ctrl+E)");
        }
    }

    fn handle_deps_key(&mut self, key: KeyEvent) -> anyhow::Result<()> {
        match key.code {
            KeyCode::Esc | KeyCode::Char('q') => {
                self.deps_viewer.close();
                self.overlay = Overlay::None;
            }
            KeyCode::Tab => {
                self.deps_viewer.toggle_section();
            }
            KeyCode::Up | KeyCode::Char('k') => self.deps_viewer.scroll_up(1),
            KeyCode::Down | KeyCode::Char('j') => self.deps_viewer.scroll_down(1),
            KeyCode::PageUp => self.deps_viewer.scroll_up(10),
            KeyCode::PageDown => self.deps_viewer.scroll_down(10),
            _ => {}
        }
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Overlay mouse handlers
    // -----------------------------------------------------------------------

    fn handle_quit_confirm_mouse(&mut self, mouse: MouseEvent) -> anyhow::Result<()> {
        let (term_cols, term_rows) = terminal::size().unwrap_or((80, 24));
        let area = Rect::new(0, 0, term_cols, term_rows.saturating_sub(1));
        let dialog_rect = Self::quit_confirm_rect(area);

        if let MouseEventKind::Down(crossterm::event::MouseButton::Left) = mouse.kind {
            if !Self::rect_contains(dialog_rect, mouse.column, mouse.row) {
                self.cancel_quit_confirmation();
            }
        }

        Ok(())
    }

    fn handle_file_conflict_mouse(&mut self, mouse: MouseEvent) -> anyhow::Result<()> {
        let (term_cols, term_rows) = terminal::size().unwrap_or((80, 24));
        let area = Rect::new(0, 0, term_cols, term_rows.saturating_sub(1));
        let dialog_rect = Self::file_conflict_rect(area);

        if let MouseEventKind::Down(crossterm::event::MouseButton::Left) = mouse.kind {
            if !Self::rect_contains(dialog_rect, mouse.column, mouse.row) {
                return Ok(());
            }

            let inner = dialog_rect.inner(Margin { horizontal: 1, vertical: 1 });
            let button_y = inner.y + inner.height.saturating_sub(2);
            if mouse.row != button_y {
                return Ok(());
            }

            let button_width = inner.width / FILE_CONFLICT_CHOICES.len() as u16;
            if button_width == 0 {
                return Ok(());
            }

            let idx = ((mouse.column.saturating_sub(inner.x)) / button_width) as usize;
            if let Some(conflict) = self.file_conflict.as_mut() {
                conflict.selected = idx.min(FILE_CONFLICT_CHOICES.len().saturating_sub(1));
            }
            match idx {
                0 => self.keep_file_conflict(),
                1 => self.reload_file_conflict(),
                2 => self.show_file_conflict_diff(),
                _ => {}
            }
        }

        Ok(())
    }

    fn handle_palette_mouse(&mut self, mouse: MouseEvent) -> anyhow::Result<()> {
        let (term_cols, term_rows) = terminal::size().unwrap_or((80, 24));
        let area = Rect::new(0, 0, term_cols, term_rows.saturating_sub(1));
        let w = 56u16.min(area.width.saturating_sub(4));
        let h = 24u16.min(area.height.saturating_sub(4));
        let x = area.x + (area.width.saturating_sub(w)) / 2;
        let y = area.y + (area.height.saturating_sub(h)) / 3;
        let palette_rect = Rect::new(x, y, w, h);

        match mouse.kind {
            MouseEventKind::Down(crossterm::event::MouseButton::Left) => {
                if !Self::rect_contains(palette_rect, mouse.column, mouse.row) {
                    self.palette.close();
                    self.overlay = Overlay::None;
                } else {
                    // Inner area: palette_rect minus borders (1 each side)
                    // Input at inner.y, separator at inner.y+1, list starts at inner.y+2
                    let list_start_y = y + 1 + 2; // border + input + separator
                    if mouse.row >= list_start_y {
                        let click_row = (mouse.row - list_start_y) as usize;
                        self.palette.click_row(click_row);
                        // Execute on click
                        if let Some(cmd) = self.palette.execute() {
                            self.execute_palette_command(&cmd)?;
                        }
                    }
                }
            }
            MouseEventKind::ScrollUp => { self.palette.move_selection(-1); }
            MouseEventKind::ScrollDown => { self.palette.move_selection(1); }
            _ => {}
        }
        Ok(())
    }

    fn handle_picker_mouse(&mut self, mouse: MouseEvent) -> anyhow::Result<()> {
        let (term_cols, term_rows) = terminal::size().unwrap_or((80, 24));
        let area = Rect::new(0, 0, term_cols, term_rows.saturating_sub(1));
        let w = 60u16.min(area.width.saturating_sub(4));
        let h = 20u16.min(area.height.saturating_sub(4));
        let x = area.x + (area.width.saturating_sub(w)) / 2;
        let y = area.y + 2;
        let picker_rect = Rect::new(x, y, w, h);

        match mouse.kind {
            MouseEventKind::Down(crossterm::event::MouseButton::Left) => {
                if !Self::rect_contains(picker_rect, mouse.column, mouse.row) {
                    self.file_picker.close();
                    self.overlay = Overlay::None;
                } else {
                    // Inner starts after the border; the list starts after the input row.
                    let list_start_y = y + 1 + 1; // border + input
                    if mouse.row >= list_start_y {
                        let click_row = (mouse.row - list_start_y) as usize;
                        self.file_picker.click_row(click_row);
                        // Execute on click (open/diff)
                        if let Some((path, mode)) = self.file_picker.execute() {
                            self.overlay = Overlay::None;
                            match mode {
                                PickerMode::Open => {
                                    self.open_file_from_files_ui(&path);
                                }
                                PickerMode::Diff => {
                                    self.open_diff_for_file(&path);
                                }
                            }
                        }
                    }
                }
            }
            MouseEventKind::ScrollUp => {
                let visible = h.saturating_sub(3) as usize;
                self.file_picker.scroll_by(-3, visible);
            }
            MouseEventKind::ScrollDown => {
                let visible = h.saturating_sub(3) as usize;
                self.file_picker.scroll_by(3, visible);
            }
            _ => {}
        }
        Ok(())
    }

    fn handle_provider_picker_mouse(&mut self, mouse: MouseEvent) -> anyhow::Result<()> {
        let (term_cols, term_rows) = terminal::size().unwrap_or((80, 24));
        let area = Rect::new(0, 0, term_cols, term_rows.saturating_sub(1));
        let w = 40u16.min(area.width.saturating_sub(4));
        let h = (PROVIDER_CHOICES.len() as u16 + 4).min(area.height.saturating_sub(4));
        let x = area.x + (area.width.saturating_sub(w)) / 2;
        let y = area.y + (area.height.saturating_sub(h)) / 2;
        let picker_rect = Rect::new(x, y, w, h);

        match mouse.kind {
            MouseEventKind::Down(crossterm::event::MouseButton::Left) => {
                if !Self::rect_contains(picker_rect, mouse.column, mouse.row) {
                    self.overlay = Overlay::None;
                } else {
                    // Inner: border (1), list items start at y+1
                    let list_start_y = y + 1; // border
                    if mouse.row >= list_start_y {
                        let click_row = (mouse.row - list_start_y) as usize;
                        if click_row < PROVIDER_CHOICES.len() {
                            self.provider_picker.selected = click_row;
                            self.confirm_provider_picker()?;
                        }
                    }
                }
            }
            MouseEventKind::ScrollUp => { self.provider_picker.move_selection(-1); }
            MouseEventKind::ScrollDown => { self.provider_picker.move_selection(1); }
            _ => {}
        }
        Ok(())
    }

    fn handle_diff_mouse(&mut self, mouse: MouseEvent) -> anyhow::Result<()> {
        let (term_cols, term_rows) = terminal::size().unwrap_or((80, 24));
        let main_area = Rect::new(0, 0, term_cols, term_rows.saturating_sub(1));

        match mouse.kind {
            MouseEventKind::Down(crossterm::event::MouseButton::Left) => {
                // Click outside the diff area closes it
                // Diff uses the full main_area, so only the status bar is outside
                // No close-on-click needed since it fills the view
            }
            MouseEventKind::ScrollUp => { self.diff_viewer.scroll_up(3); }
            MouseEventKind::ScrollDown => { self.diff_viewer.scroll_down(3); }
            _ => {}
        }
        let _ = main_area; // suppress unused warning
        Ok(())
    }

    fn handle_deps_mouse(&mut self, mouse: MouseEvent) -> anyhow::Result<()> {
        let (term_cols, term_rows) = terminal::size().unwrap_or((80, 24));
        let area = Rect::new(0, 0, term_cols, term_rows.saturating_sub(1));
        // The deps viewer uses 80% of area
        let w = (area.width * 4 / 5).max(40).min(area.width);
        let h = (area.height * 4 / 5).max(10).min(area.height);
        let x = area.x + (area.width.saturating_sub(w)) / 2;
        let y = area.y + (area.height.saturating_sub(h)) / 2;
        let overlay_rect = Rect::new(x, y, w, h);

        match mouse.kind {
            MouseEventKind::Down(crossterm::event::MouseButton::Left) => {
                if !Self::rect_contains(overlay_rect, mouse.column, mouse.row) {
                    self.deps_viewer.close();
                    self.overlay = Overlay::None;
                } else {
                    // Inner area minus border
                    let inner_y = y + 1;
                    let inner_h = h.saturating_sub(2);
                    let half = (inner_h / 2).max(2);
                    // Imports section: inner_y to inner_y + half
                    // Imported-by section: inner_y + half to end
                    if mouse.row >= inner_y && mouse.row < inner_y + half {
                        self.deps_viewer.focus_imports();
                    } else if mouse.row >= inner_y + half {
                        self.deps_viewer.focus_imported_by();
                    }
                }
            }
            MouseEventKind::ScrollUp => { self.deps_viewer.scroll_up(1); }
            MouseEventKind::ScrollDown => { self.deps_viewer.scroll_down(1); }
            _ => {}
        }
        Ok(())
    }

    fn handle_outline_mouse(&mut self, mouse: MouseEvent) -> anyhow::Result<()> {
        let (term_cols, term_rows) = terminal::size().unwrap_or((80, 24));
        let area = Rect::new(0, 0, term_cols, term_rows.saturating_sub(1));
        let w = 50u16.min(area.width.saturating_sub(4));
        let h = 20u16.min(area.height.saturating_sub(4));
        let x = area.x + (area.width.saturating_sub(w)) / 2;
        let y = area.y + (area.height.saturating_sub(h)) / 3;
        let popup_rect = Rect::new(x, y, w, h);

        match mouse.kind {
            MouseEventKind::Down(crossterm::event::MouseButton::Left) => {
                if !Self::rect_contains(popup_rect, mouse.column, mouse.row) {
                    self.editor.close_outline();
                } else {
                    // Inner: border (1) + input line (1), list starts at inner.y + 1
                    let list_start_y = y + 1 + 1; // border + input
                    if mouse.row >= list_start_y {
                        let click_row = (mouse.row - list_start_y) as usize;
                        let count = self.editor.filtered_outline().len();
                        if click_row < count {
                            // Select and confirm
                            self.editor.outline_select(click_row);
                            self.editor.outline_confirm();
                        }
                    }
                }
            }
            MouseEventKind::ScrollUp => { self.editor.outline_move(-1); }
            MouseEventKind::ScrollDown => { self.editor.outline_move(1); }
            _ => {}
        }
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Sidebar
    // -----------------------------------------------------------------------

    /// Reload the sidebar file tree if the focused agent's cwd differs from the previous.
    fn refresh_sidebar_if_cwd_changed(&mut self, old_cwd: &str) {
        if self.sidebar_open {
            let new_cwd = self.current_cwd();
            if new_cwd != old_cwd {
                self.file_tree.load(&new_cwd);
            }
        }
    }

    /// Ensure the sidebar is open and focused (used by palette commands).
    fn ensure_sidebar_focused(&mut self) {
        if !self.sidebar_open {
            let cwd = self.current_cwd();
            self.file_tree.load(&cwd);
            self.sidebar_open = true;
            let (term_cols, term_rows) = terminal::size().unwrap_or((80, 24));
            self.handle_resize(term_cols, term_rows).ok();
        }
        self.sidebar_focused = true;
    }

    fn toggle_sidebar(&mut self) {
        if !self.sidebar_open {
            // Open and focus
            let cwd = self.current_cwd();
            self.file_tree.load(&cwd);
            self.sidebar_open = true;
            self.sidebar_focused = true;
        } else if self.sidebar_focused {
            // Already focused → close it
            self.sidebar_open = false;
            self.sidebar_focused = false;
        } else {
            // Open but unfocused → focus it
            self.sidebar_focused = true;
        }
        // Sidebar changes available width — resize all agent panes.
        let (term_cols, term_rows) = terminal::size().unwrap_or((80, 24));
        self.handle_resize(term_cols, term_rows).ok();
    }

    fn handle_sidebar_key(&mut self, key: KeyEvent) -> anyhow::Result<()> {
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);

        // If inline input mode is active, route all keys there first.
        if self.file_tree.is_input_active() {
            match key.code {
                KeyCode::Esc => {
                    self.file_tree.cancel_input();
                    self.set_status("Cancelled");
                }
                KeyCode::Enter => {
                    match self.file_tree.confirm_input() {
                        Ok(Some(msg)) => {
                            self.file_tree.refresh();
                            self.set_status(msg);
                        }
                        Ok(None) => {}
                        Err(e) => self.set_status(format!("Error: {}", e)),
                    }
                }
                KeyCode::Backspace => {
                    self.file_tree.input_backspace();
                }
                KeyCode::Char(c) => {
                    self.file_tree.input_char(c);
                }
                _ => {}
            }
            return Ok(());
        }

        // If a move is pending, handle move-specific keys.
        if self.file_tree.is_move_pending() {
            match key.code {
                KeyCode::Esc => {
                    self.file_tree.cancel_move();
                    self.set_status("Move cancelled");
                }
                KeyCode::Enter => {
                    match self.file_tree.complete_move() {
                        Ok(msg) => {
                            self.file_tree.refresh();
                            self.set_status(msg);
                        }
                        Err(e) => self.set_status(format!("Move failed: {}", e)),
                    }
                }
                // Still allow navigation while move is pending
                KeyCode::Up | KeyCode::Char('k') => self.file_tree.move_up(),
                KeyCode::Down | KeyCode::Char('j') => self.file_tree.move_down(),
                KeyCode::PageUp => self.file_tree.move_by(-10),
                KeyCode::PageDown => self.file_tree.move_by(10),
                KeyCode::Home => self.file_tree.move_first(),
                KeyCode::End => self.file_tree.move_last(),
                _ => {}
            }
            return Ok(());
        }

        match (ctrl, key.code) {
            // Ctrl+E or Esc/Tab: unfocus sidebar (or close if ctrl)
            (true, KeyCode::Char('e')) => {
                self.sidebar_open = false;
                self.sidebar_focused = false;
            }
            (_, KeyCode::Esc) | (_, KeyCode::Tab) => {
                self.sidebar_focused = false;
            }
            // Navigation
            (_, KeyCode::Up) | (_, KeyCode::Char('k')) => self.file_tree.move_up(),
            (_, KeyCode::Down) | (_, KeyCode::Char('j')) => self.file_tree.move_down(),
            (_, KeyCode::PageUp) => self.file_tree.move_by(-10),
            (_, KeyCode::PageDown) => self.file_tree.move_by(10),
            (_, KeyCode::Home) => self.file_tree.move_first(),
            (_, KeyCode::End) => self.file_tree.move_last(),
            // Activate: expand dir or open file
            (_, KeyCode::Enter) | (_, KeyCode::Char(' ')) => {
                if let Some(path) = self.file_tree.activate_selected() {
                    let path_str = path.to_string_lossy().to_string();
                    self.open_file_from_files_ui(&path_str);
                }
            }
            // 'e' — explicitly open selected file in editor
            (_, KeyCode::Char('e')) => {
                if let Some(path) = self.file_tree.selected_path() {
                    if !path.is_dir() {
                        let path_str = path.to_string_lossy().to_string();
                        self.open_file_from_files_ui(&path_str);
                    }
                }
            }
            // 'd' — open diff for selected file
            (_, KeyCode::Char('d')) => {
                if let Some(path) = self.file_tree.selected_path() {
                    if !path.is_dir() {
                        let path_str = path.to_string_lossy().to_string();
                        self.sidebar_focused = false;
                        self.open_diff_for_file(&path_str);
                    }
                }
            }
            // 'i' — inspect deps for selected file
            (_, KeyCode::Char('i')) => {
                if let Some(path) = self.file_tree.selected_path() {
                    if !path.is_dir() {
                        let path_str = path.to_string_lossy().to_string();
                        let cwd = self.current_cwd();
                        self.sidebar_focused = false;
                        self.deps_viewer.open_for(&path_str, &cwd);
                        let broken = self.deps_viewer.broken_count();
                        if broken > 0 {
                            self.set_status(format!(
                                "Deps: {} import{}, {} broken",
                                self.deps_viewer.imports.len(),
                                if self.deps_viewer.imports.len() == 1 { "" } else { "s" },
                                broken
                            ));
                        } else {
                            self.set_status(format!(
                                "Deps: {} import{}",
                                self.deps_viewer.imports.len(),
                                if self.deps_viewer.imports.len() == 1 { "" } else { "s" }
                            ));
                        }
                        self.overlay = Overlay::Deps;
                    }
                }
            }
            // 'n' — new file
            (_, KeyCode::Char('n')) => {
                self.file_tree.start_new_file();
                self.set_status("New file: type name, Enter to create, Esc to cancel");
            }
            // 'N' (Shift+N) — new folder
            (_, KeyCode::Char('N')) => {
                self.file_tree.start_new_folder();
                self.set_status("New folder: type name, Enter to create, Esc to cancel");
            }
            // F2 — rename
            (_, KeyCode::F(2)) => {
                self.file_tree.start_rename();
                self.set_status("Rename: edit name, Enter to confirm, Esc to cancel");
            }
            // 'x' or Delete — delete
            (_, KeyCode::Char('x')) | (_, KeyCode::Delete) => {
                match self.file_tree.delete_selected() {
                    Ok(msg) => {
                        self.file_tree.refresh();
                        self.set_status(msg);
                    }
                    Err(e) => self.set_status(format!("Delete failed: {}", e)),
                }
            }
            // 'y' — duplicate
            (_, KeyCode::Char('y')) => {
                match self.file_tree.duplicate_selected() {
                    Ok(msg) => {
                        self.file_tree.refresh();
                        self.set_status(msg);
                    }
                    Err(e) => self.set_status(format!("Duplicate failed: {}", e)),
                }
            }
            // 'm' — start move
            (_, KeyCode::Char('m')) => {
                self.file_tree.start_move();
                self.set_status("Move: navigate to destination, Enter to drop, Esc to cancel");
            }
            // 'r' — refresh tree
            (_, KeyCode::Char('r')) => {
                self.file_tree.refresh();
                self.set_status("Tree refreshed");
            }
            _ => {}
        }
        Ok(())
    }

    fn open_diff_for_file(&mut self, path: &str) {
        // Run `git diff` on the file
        let cwd = self.current_cwd();
        let output = std::process::Command::new("git")
            .args(["diff", "HEAD", "--", path])
            .current_dir(&cwd)
            .output();

        match output {
            Ok(out) => {
                let diff_text = String::from_utf8_lossy(&out.stdout);
                if diff_text.trim().is_empty() {
                    // Try unstaged diff
                    let out2 = std::process::Command::new("git")
                        .args(["diff", "--", path])
                        .current_dir(&cwd)
                        .output();
                    if let Ok(out2) = out2 {
                        let text2 = String::from_utf8_lossy(&out2.stdout);
                        if text2.trim().is_empty() {
                            self.set_status("No changes for this file");
                            return;
                        }
                        self.diff_viewer.open_with(&text2);
                    }
                } else {
                    self.diff_viewer.open_with(&diff_text);
                }
                self.overlay = Overlay::Diff;
            }
            Err(e) => self.set_status(format!("git diff failed: {}", e)),
        }
    }

    fn handle_resize(&mut self, _cols: u16, _rows: u16) -> anyhow::Result<()> {
        // Use the same geometry helper as render(): accounts for sidebar,
        // status bar, AND the editor split panel. The previous version
        // ignored the editor panel, so the PTY thought each pane was
        // wider than it really was — Copilot/Ink would paint past the
        // visible edge and mouse coords we sent didn't line up with what
        // the CLI saw.
        let areas = self.pane_rects();
        for (i, agent) in self.agents.iter().enumerate() {
            if let Some(area) = areas.get(i) {
                // Account for border (2) on each side
                let pane_rows = area.height.saturating_sub(2);
                let pane_cols = area.width.saturating_sub(2);
                if let Some(tid) = self.agent_terminals.get(&agent.id) {
                    if let Some(inst) = self.terminal_mgr.get_mut(tid) {
                        inst.resize(pane_cols, pane_rows).ok();
                    }
                }
            }
        }
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Theme
    // -----------------------------------------------------------------------

    /// Scroll the focused pane. Negative delta = scroll up (into history), positive = toward live.
    ///
    /// Two paths:
    /// 1. Main-screen TUIs (Codex, Claude, Gemini): manipulate alacritty's
    ///    scrollback offset locally — fast, never disturbs the CLI.
    /// 2. Alt-screen TUIs (Copilot, vim, less): alacritty has no scrollback in
    ///    alt-screen mode, so forward arrow / PgUp / PgDn key sequences to the
    ///    PTY and let the CLI's own UI scroll itself.
    fn scroll_focused(&mut self, delta: i32) {
        let Some(agent) = self.agents.get(self.focused) else { return };
        let terminal_id = match self.agent_terminals.get(&agent.id) {
            Some(tid) => tid.clone(),
            None => return,
        };
        let Some(instance) = self.terminal_mgr.get(&terminal_id) else { return };

        // Alt-screen path: forward to PTY. Ink-based chat UIs (Copilot,
        // Gemini) enable mouse reporting and scroll in response to SGR
        // wheel events, but treat arrow keys as prompt-history navigation —
        // so we prefer wheel escapes whenever the app has mouse tracking
        // on, and fall back to PgUp/PgDn + arrow keys otherwise (vim,
        // less, fzf, etc).
        if instance.is_alt_screen() {
            if delta == 0 {
                return;
            }
            // Compute the focused pane's center in PTY-local coords (1-indexed).
            // Copilot/Ink dispatches wheel events to whichever component is
            // under the cursor — sending at (1,1) often lands on the header
            // or input bar. Aiming at the pane center reliably hits the
            // chat-history region.
            let (cx, cy) = self
                .focused_pane_rect()
                .map(|r| {
                    let col = r.width / 2 + 1;
                    let row = r.height / 2 + 1;
                    (col.max(1), row.max(1))
                })
                .unwrap_or((1, 1));

            let bytes: Vec<u8> = if instance.mouse_reporting_enabled() && delta.abs() < 20 {
                // SGR mouse wheel: ESC [ < 64 ; col ; row M  (wheel up)
                //                  ESC [ < 65 ; col ; row M  (wheel down)
                // One event per unit of delta; page-granularity scrolls
                // (|delta| >= 20) still fall through to PgUp/PgDn below.
                let button = if delta < 0 { 64 } else { 65 };
                let n = delta.unsigned_abs() as usize;
                let evt = format!("\x1b[<{button};{cx};{cy}M");
                let mut v = Vec::with_capacity(evt.len() * n);
                for _ in 0..n {
                    v.extend_from_slice(evt.as_bytes());
                }
                v
            } else if delta <= -20 {
                b"\x1b[5~".to_vec() // PgUp
            } else if delta >= 20 {
                b"\x1b[6~".to_vec() // PgDn
            } else if !instance.mouse_reporting_enabled() {
                // No mouse reporting — Copilot-style apps won't see wheel
                // events at all, and arrow keys collide with their prompt
                // history nav. Use PgUp/PgDn as the universal scroll: it
                // pages through chat history on Copilot and scrolls in
                // less/vim. One press per wheel tick.
                let evt: &[u8] = if delta < 0 { b"\x1b[5~" } else { b"\x1b[6~" };
                let n = delta.unsigned_abs() as usize;
                let mut v = Vec::with_capacity(evt.len() * n);
                for _ in 0..n {
                    v.extend_from_slice(evt);
                }
                v
            } else {
                // Mouse reporting on but somehow we got here (delta in the
                // arrow-key fallback range). Should not happen with current
                // logic, but keep arrow keys as a safe default.
                let arrow: &[u8] = if delta < 0 { b"\x1b[A" } else { b"\x1b[B" };
                let n = delta.unsigned_abs() as usize;
                let mut v = Vec::with_capacity(arrow.len() * n);
                for _ in 0..n {
                    v.extend_from_slice(arrow);
                }
                v
            };
            let _ = instance.write(&bytes);
            return;
        }

        // Main-screen path: manipulate local scrollback offset.
        // Use a blocking lock here — a one-shot user scroll can wait the few µs
        // for the PTY reader to release the mutex. (Render uses try_lock to stay
        // responsive; user actions should not silently drop.)
        let max_scroll = match instance.term.lock() {
            Ok(t) => t.grid().history_size(),
            Err(_) => return,
        };

        let current = *self.scroll_offsets.get(&agent.id).unwrap_or(&0);
        let new_offset = if delta < 0 {
            (current + (-delta) as usize).min(max_scroll)
        } else {
            current.saturating_sub(delta as usize)
        };
        self.scroll_offsets.insert(agent.id.clone(), new_offset);

        if new_offset > 0 {
            self.set_status(format!("Scrolled back {} lines (Shift+↓ to return)", new_offset));
        } else {
            self.status_msg = None;
        }
    }

    // -----------------------------------------------------------------------
    // Agent lifecycle
    // -----------------------------------------------------------------------

    /// Open the provider picker overlay — Ctrl+N entrypoint.
    fn open_provider_picker(&mut self) {
        self.provider_picker.open(None);
        self.overlay = Overlay::ProviderPicker;
    }

    fn add_agent_with_provider(&mut self, provider: Provider) -> anyhow::Result<()> {
        let cwd = self.current_cwd();
        self.add_agent_in_with_provider(cwd, provider)
    }

    fn add_agent_in_with_provider(&mut self, cwd: String, provider: Provider) -> anyhow::Result<()> {
        if self.agents.len() >= self.config.max_agents {
            self.set_status(format!("Max {} agents reached", self.config.max_agents));
            return Ok(());
        }

        // Validate the directory exists
        if !std::path::Path::new(&cwd).is_dir() {
            self.set_status(format!("Not a directory: {}", cwd));
            return Ok(());
        }
        let id = uid();
        let terminal_id = uid();
        // Pick the lowest "Agent N" number not already in use so default
        // names stay sequential even when customs are mixed in.
        let used: std::collections::HashSet<u32> = self
            .agents
            .iter()
            .filter_map(|a| parse_default_agent_number(&a.name))
            .collect();
        let mut n = 1u32;
        while used.contains(&n) { n += 1; }
        let name = format!("Agent {}", n);

        let (program, args) = match provider {
            Provider::Claude => {
                if let Some(cli) = fs_agent::find_claude_cli() {
                    (cli.to_string_lossy().to_string(), fs_agent::claude_args(None))
                } else {
                    self.set_status("Claude CLI not found — install with: npm i -g @anthropic-ai/claude-code");
                    return Ok(());
                }
            }
            Provider::Codex => {
                if let Some(cli) = fs_agent::find_codex_cli() {
                    (cli.to_string_lossy().to_string(), fs_agent::codex_args())
                } else {
                    self.set_status("Codex CLI not found — install with: npm i -g @openai/codex");
                    return Ok(());
                }
            }
            Provider::Copilot => {
                if let Some(cli) = fs_agent::find_copilot_cli() {
                    (cli.to_string_lossy().to_string(), fs_agent::copilot_args())
                } else {
                    self.set_status("Copilot CLI not found — install with: npm i -g @github/copilot");
                    return Ok(());
                }
            }
            Provider::Gemini => {
                if let Some(cli) = fs_agent::find_gemini_cli() {
                    (cli.to_string_lossy().to_string(), fs_agent::gemini_args())
                } else {
                    self.set_status("Gemini CLI not found — install with: npm i -g @google/gemini-cli");
                    return Ok(());
                }
            }
            Provider::Terminal => {
                let shell = fs_agent::find_shell();
                (shell.to_string_lossy().to_string(), fs_agent::shell_args())
            }
        };

        let env = fs_agent::build_clean_env();

        // Start with a placeholder size; handle_resize will correct all panes after layout.
        self.terminal_mgr.create(
            terminal_id.clone(),
            &program,
            &args,
            &cwd,
            env,
            80,
            22,
        )?;

        self.agent_terminals.insert(id.clone(), terminal_id);

        let folder = std::path::Path::new(&cwd)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| cwd.clone());

        self.agents.push(AgentDescriptor {
            id,
            name,
            cwd,
            provider,
        });

        let old_cwd = self.current_cwd();
        self.focused = self.agents.len() - 1;
        self.refresh_sidebar_if_cwd_changed(&old_cwd);

        // Resize all panes (existing + new) to fit the updated grid layout.
        let (term_cols, term_rows) = terminal::size().unwrap_or((80, 24));
        self.handle_resize(term_cols, term_rows)?;

        self.set_status(format!("{} agent created in {}", provider.label(), folder));
        Ok(())
    }

    /// Close the focused agent and remove its pane, renumbering the rest.
    fn close_focused_agent(&mut self) {
        if self.agents.is_empty() {
            return;
        }
        let idx = self.focused;
        self.remove_agent_at(idx);
        let (term_cols, term_rows) = terminal::size().unwrap_or((80, 24));
        self.handle_resize(term_cols, term_rows).ok();
        self.set_status("Agent closed");
    }

    /// Remove the agent at `idx` and clean up its associated state. Caller
    /// is responsible for triggering a resize once batched removals finish.
    fn remove_agent_at(&mut self, idx: usize) {
        if idx >= self.agents.len() {
            return;
        }
        let old_cwd = self.current_cwd();
        let agent = self.agents.remove(idx);

        if let Some(tid) = self.agent_terminals.remove(&agent.id) {
            self.terminal_mgr.close(&tid);
            self.last_terminal_revisions.remove(&tid);
        }
        self.scroll_offsets.remove(&agent.id);

        // Renumber default-named agents only — custom names (set via Ctrl+R)
        // are preserved across closes.
        let mut next = 1u32;
        for a in self.agents.iter_mut() {
            if parse_default_agent_number(&a.name).is_some() {
                a.name = format!("Agent {}", next);
                next += 1;
            }
        }

        if !self.agents.is_empty() {
            // If we removed at or before the focused index, shift focus left
            // so we don't skip past a neighbor.
            if idx < self.focused {
                self.focused -= 1;
            }
            self.focused = self.focused.min(self.agents.len() - 1);
            self.refresh_sidebar_if_cwd_changed(&old_cwd);
        } else {
            self.focused = 0;
            // Falls back to process cwd — refresh sidebar if it's open
            self.refresh_sidebar_if_cwd_changed(&old_cwd);
        }
    }

    /// Spawn `claude --print` in a background thread to apply an AI edit.
    fn spawn_ai_edit(&self, instruction: String, file_path: String) {
        let tx = self.ai_tx.clone();
        let cwd = self.current_cwd();

        let cli = match fs_agent::find_claude_cli() {
            Some(p) => p,
            None => {
                tx.send(AiEditResult {
                    success: false,
                    message: "Claude CLI not found".into(),
                    file_path: file_path.clone(),
                    original_content: None,
                }).ok();
                return;
            }
        };

        // Capture original content for diff
        let original_content = std::fs::read_to_string(&file_path).ok();

        std::thread::Builder::new()
            .name("ai-edit".into())
            .spawn(move || {
                let prompt = format!(
                    "Edit the file {} according to this instruction: {}\n\
                     Only edit the file — do not create new files. Be precise and minimal.",
                    file_path, instruction
                );

                let result = std::process::Command::new(cli)
                    .arg("--print")
                    .arg("--allowedTools")
                    .arg("Edit,Read")
                    .arg("--dangerously-skip-permissions")
                    .arg(&prompt)
                    .current_dir(&cwd)
                    .env("CLAUDE_CODE_ENTRYPOINT", "cli")
                    .output();

                match result {
                    Ok(output) => {
                        if output.status.success() {
                            tx.send(AiEditResult {
                                success: true,
                                message: "AI edit applied — Ctrl+D to view diff".into(),
                                file_path,
                                original_content,
                            }).ok();
                        } else {
                            let stderr = String::from_utf8_lossy(&output.stderr);
                            let msg = if stderr.trim().is_empty() {
                                "AI edit failed".to_string()
                            } else {
                                format!("AI: {}", stderr.trim().chars().take(80).collect::<String>())
                            };
                            tx.send(AiEditResult {
                                success: false,
                                message: msg,
                                file_path,
                                original_content: None,
                            }).ok();
                        }
                    }
                    Err(e) => {
                        tx.send(AiEditResult {
                            success: false,
                            message: format!("Failed to run claude: {}", e),
                            file_path,
                            original_content: None,
                        }).ok();
                    }
                }
            })
            .ok();
    }

    fn current_cwd(&self) -> String {
        if let Some(agent) = self.agents.get(self.focused) {
            agent.cwd.clone()
        } else {
            std::env::current_dir()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string()
        }
    }

    /// Check if a mouse position is over the editor panel area.
    fn is_mouse_over_editor(&self, col: u16, _row: u16) -> bool {
        if self.content_area_width == 0 { return false; }
        if self.editor_focus_mode {
            // Editor is on the LEFT in focus mode; agents take a small slice on the right.
            let agent_w = ((self.content_area_width as u32 * 18 / 100) as u16).clamp(20, 36);
            let editor_end = self.content_area_x + self.content_area_width.saturating_sub(agent_w);
            col < editor_end
        } else {
            let agent_pct = 100u16.saturating_sub(self.editor_split_pct);
            let editor_start = self.content_area_x
                + (self.content_area_width as u32 * agent_pct as u32 / 100) as u16;
            col >= editor_start
        }
    }

    // -----------------------------------------------------------------------
    // Rendering
    // -----------------------------------------------------------------------

    fn render_quit_confirm(&self, frame: &mut Frame, area: Rect) {
        let dialog_area = Self::quit_confirm_rect(area);
        if dialog_area.width < 24 || dialog_area.height < 5 {
            return;
        }

        frame.render_widget(Clear, dialog_area);

        let block = Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(self.theme.red))
            .title(Span::styled(
                " Quit FluidState? ",
                Style::default().fg(self.theme.text).add_modifier(Modifier::BOLD),
            ));
        let inner = block.inner(dialog_area);
        frame.render_widget(block, dialog_area);

        if inner.height == 0 {
            return;
        }

        let lines = vec![
            Line::from(Span::styled(
                "Are you sure you want to quit?",
                Style::default().fg(self.theme.text).add_modifier(Modifier::BOLD),
            )),
            Line::from(""),
            Line::from(vec![
                Span::styled(
                    "Ctrl+Q",
                    Style::default().fg(self.theme.text).add_modifier(Modifier::BOLD),
                ),
                Span::styled(" again to quit", Style::default().fg(self.theme.text)),
            ]),
            Line::from(vec![
                Span::styled("Esc", Style::default().fg(self.theme.text).add_modifier(Modifier::BOLD)),
                Span::styled(" or ", Style::default().fg(self.theme.text_muted)),
                Span::styled("n", Style::default().fg(self.theme.text).add_modifier(Modifier::BOLD)),
                Span::styled(" to cancel", Style::default().fg(self.theme.text_muted)),
            ]),
        ];

        frame.render_widget(
            Paragraph::new(Text::from(lines))
                .alignment(Alignment::Center)
                .style(Style::default().fg(self.theme.text)),
            inner,
        );
    }

    fn render_file_conflict(&self, frame: &mut Frame, area: Rect) {
        let Some(conflict) = self.file_conflict.as_ref() else {
            return;
        };

        let dialog_area = Self::file_conflict_rect(area);
        if dialog_area.width < 36 || dialog_area.height < 7 {
            return;
        }

        frame.render_widget(Clear, dialog_area);

        let block = Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(self.theme.amber))
            .title(Span::styled(
                " File Changed On Disk ",
                Style::default().fg(self.theme.text).add_modifier(Modifier::BOLD),
            ));
        let inner = block.inner(dialog_area);
        frame.render_widget(block, dialog_area);

        if inner.height < 5 || inner.width == 0 {
            return;
        }

        let filename = Path::new(&conflict.path)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| conflict.path.clone());

        let message = vec![
            Line::from(Span::styled(
                filename,
                Style::default().fg(self.theme.text).add_modifier(Modifier::BOLD),
            )),
            Line::from(Span::styled(
                "You have unsaved edits, and the file on disk changed.",
                Style::default().fg(self.theme.text),
            )),
            Line::from(Span::styled(
                "Choose how to resolve it.",
                Style::default().fg(self.theme.text_muted),
            )),
        ];

        frame.render_widget(
            Paragraph::new(Text::from(message))
                .alignment(Alignment::Center)
                .style(Style::default().fg(self.theme.text)),
            Rect::new(inner.x, inner.y, inner.width, inner.height.saturating_sub(2)),
        );

        let button_y = inner.y + inner.height.saturating_sub(2);
        let button_w = inner.width / FILE_CONFLICT_CHOICES.len() as u16;
        if button_w == 0 {
            return;
        }

        for (idx, label) in FILE_CONFLICT_CHOICES.iter().enumerate() {
            let x = inner.x + button_w.saturating_mul(idx as u16);
            let width = if idx + 1 == FILE_CONFLICT_CHOICES.len() {
                inner.x + inner.width - x
            } else {
                button_w
            };
            let selected = idx == conflict.selected;
            let style = if selected {
                Style::default()
                    .fg(Color::Black)
                    .bg(self.theme.amber)
                    .add_modifier(Modifier::BOLD)
            } else {
                Style::default()
                    .fg(self.theme.text)
                    .bg(self.theme.bg_surface)
            };
            let text = format!(" {}. {} ", idx + 1, label);
            let truncated: String = text.chars().take(width as usize).collect();
            let trailing = " ".repeat((width as usize).saturating_sub(truncated.chars().count()));
            frame.render_widget(
                Paragraph::new(format!("{}{}", truncated, trailing))
                    .alignment(Alignment::Center)
                    .style(style),
                Rect::new(x, button_y, width, 1),
            );
        }
    }

    fn render(&mut self, frame: &mut Frame) {
        // Resize agent PTYs to match the visible pane dimensions whenever
        // the layout has changed (editor opened/closed, sidebar toggled,
        // split dragged, etc.) — keeps Copilot/Ink's painted width and
        // mouse coords aligned with what we render.
        self.relayout_if_needed();

        let area = frame.area();

        // Split vertically: main content + 1-row status bar
        let chunks = Layout::default()
            .direction(Direction::Vertical)
            .constraints([Constraint::Min(1), Constraint::Length(1)])
            .split(area);
        let main_area = chunks[0];
        let status_area = chunks[1];

        // Split horizontally: optional sidebar + content area
        let (sidebar_area, content_area) = if self.sidebar_open {
            let h = Layout::default()
                .direction(Direction::Horizontal)
                .constraints([Constraint::Length(SIDEBAR_WIDTH), Constraint::Min(0)])
                .split(main_area);
            (Some(h[0]), h[1])
        } else {
            (None, main_area)
        };

        // Render sidebar
        if let Some(sa) = sidebar_area {
            self.file_tree.render(frame, sa, &self.theme, self.sidebar_focused);
        }

        // Cache content area for mouse drag hit-testing
        self.content_area_x = content_area.x;
        self.content_area_width = content_area.width;

        // Split content: agent grid + optional editor panel.
        // - Default: agents left, editor right, sized by `editor_split_pct`.
        // - Focus mode: editor LEFT (dominant), agents shrunk to a thin column on the RIGHT.
        let (agent_area, editor_panel_area) = if self.editor.is_open() {
            if self.editor_focus_mode {
                // Agents get a small fixed slice (or 18% — whichever is bigger up to 36 cols)
                let agent_w = ((content_area.width as u32 * 18 / 100) as u16).clamp(20, 36);
                let editor_w = content_area.width.saturating_sub(agent_w);
                let h = Layout::default()
                    .direction(Direction::Horizontal)
                    .constraints([Constraint::Length(editor_w), Constraint::Length(agent_w)])
                    .split(content_area);
                (h[1], Some(h[0]))
            } else {
                let agent_pct = 100u16.saturating_sub(self.editor_split_pct);
                let h = Layout::default()
                    .direction(Direction::Horizontal)
                    .constraints([Constraint::Percentage(agent_pct), Constraint::Percentage(self.editor_split_pct)])
                    .split(content_area);
                (h[0], Some(h[1]))
            }
        } else {
            (content_area, None)
        };

        // Render agent grid (or welcome screen)
        let agent_focused = !self.sidebar_focused && self.overlay != Overlay::Editor;
        if self.agents.is_empty() {
            render::render_welcome(frame, agent_area, &self.theme);
        } else {
            let pane_areas = grid::compute_grid(agent_area, self.agents.len());
            for (i, agent) in self.agents.iter().enumerate() {
                if let Some(&pane_area) = pane_areas.get(i) {
                    let is_focused = i == self.focused && agent_focused;
                    let terminal_id = self.agent_terminals.get(&agent.id);
                    let instance =
                        terminal_id.and_then(|tid| self.terminal_mgr.get(tid));
                    let scroll = self.scroll_offsets.get(&agent.id).copied().unwrap_or(0);
                    let sel = self.pane_selection.as_ref().filter(|s| s.agent_idx == i);
                    render::render_pane(frame, pane_area, agent, is_focused, instance, scroll, sel, &self.theme);
                }
            }
        }

        // Render editor side panel (always visible when a file is open)
        if let Some(ea) = editor_panel_area {
            self.editor.render(frame, ea, self.overlay == Overlay::Editor, &self.theme);
        }

        let provider_picker_hint = format!(
            " ↑↓ navigate │ 1-{} select │ Enter confirm │ Esc cancel ",
            PROVIDER_CHOICES.len()
        );
        let hint: &str = match self.overlay {
            Overlay::Editor =>
                " ^G ask AI │ ^S save │ ^W close │ Esc unfocus editor ",
            Overlay::Diff =>
                " ↑↓/jk scroll │ ←→/hl prev/next file │ e edit │ q close ",
            Overlay::FilePicker =>
                " ↑↓ navigate │ PgUp/Dn │ Enter open │ Esc cancel ",
            Overlay::FolderInput =>
                " Tab complete │ Enter confirm │ Esc cancel ",
            Overlay::ProviderPicker => &provider_picker_hint,
            Overlay::QuitConfirm =>
                " Ctrl+Q again to quit │ Esc/n cancel ",
            Overlay::FileConflict =>
                " ←/→ choose │ Enter confirm │ 1 keep │ 2 reload │ 3 diff │ Esc keep ",
            Overlay::Palette =>
                " ↑↓ navigate │ Enter run │ Esc cancel ",
            Overlay::Deps =>
                " Tab switch │ j/k scroll │ PgUp/Dn │ q/Esc close ",
            Overlay::RenameAgent =>
                " type ≤8 chars │ Enter save │ Esc cancel ",
            Overlay::None if self.sidebar_focused =>
                " ↑↓/jk navigate │ PgUp/Dn │ Enter expand/open │ e open │ d diff │ i deps │ r refresh │ Esc unfocus ",
            Overlay::None if self.editor.is_open() =>
                " ^F focus editor │ ^B big editor │ ^W close │ Tab cycle │ ^E tree │ ^D diff │ ^I deps │ ^K palette ",
            Overlay::None if self.focused_is_terminal() =>
                " shell keys forwarded │ ^Shift+W close pane │ ^→/^← switch pane │ Wheel/Shift+↑↓ scroll │ ^Q quit ",
            Overlay::None =>
                " ^N new │ ^W close │ ^R rename │ Tab cycle │ ^E tree │ ^O open │ Alt+↑↓ scroll │ ^K palette │ ^Q quit ",
        };

        render::render_status_bar(
            frame,
            status_area,
            &self.agents,
            self.focused,
            self.status_msg.as_ref().map(|(m, _)| m.as_str()),
            hint,
            &self.theme,
        );

        // Overlays (rendered on top of everything — editor is now a side panel, not here)
        match self.overlay {
            Overlay::Palette    => self.palette.render(frame, area, &self.theme),
            Overlay::FilePicker => self.file_picker.render(frame, area, &self.theme),
            Overlay::FolderInput => self.folder_input.render(frame, area, &self.theme),
            Overlay::ProviderPicker => self.provider_picker.render(frame, area, &self.theme),
            Overlay::QuitConfirm => self.render_quit_confirm(frame, area),
            Overlay::FileConflict => self.render_file_conflict(frame, area),
            Overlay::Editor     => {} // rendered inline as side panel above
            Overlay::Diff       => self.diff_viewer.render(frame, main_area, &self.theme),
            Overlay::Deps       => self.deps_viewer.render(frame, main_area, &self.theme),
            Overlay::RenameAgent => self.rename_agent.render(frame, area, &self.theme),
            Overlay::None       => {}
        }
    }
}

fn is_image_file(path: &str) -> bool {
    let Some(ext) = Path::new(path).extension().and_then(|e| e.to_str()) else {
        return false;
    };
    matches!(
        ext.to_ascii_lowercase().as_str(),
        "png" | "jpg" | "jpeg" | "gif" | "bmp" | "webp" |
        "tif" | "tiff" | "ico" | "heic" | "avif" | "svg"
    )
}

fn file_open_target(path: &str) -> FileOpenTarget {
    if is_image_file(path) {
        FileOpenTarget::External
    } else {
        FileOpenTarget::Editor
    }
}

fn should_fallback_to_external(path: &str, editor_err: &str) -> bool {
    Path::new(path).is_file() && editor_err.contains("stream did not contain valid UTF-8")
}

fn open_external_file(path: &str) -> Result<(), String> {
    if !Path::new(path).exists() {
        return Err("File does not exist".to_string());
    }

    #[cfg(target_os = "macos")]
    {
        let status = std::process::Command::new("open")
            .arg(path)
            .status()
            .map_err(|e| format!("Could not open external viewer: {}", e))?;
        return if status.success() {
            Ok(())
        } else {
            Err(format!("External viewer exited with status {}", status))
        };
    }

    #[cfg(target_os = "windows")]
    {
        let status = std::process::Command::new("cmd")
            .args(["/C", "start", "", path])
            .status()
            .map_err(|e| format!("Could not open external viewer: {}", e))?;
        return if status.success() {
            Ok(())
        } else {
            Err(format!("External viewer exited with status {}", status))
        };
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let status = std::process::Command::new("xdg-open")
            .arg(path)
            .status()
            .map_err(|e| format!("Could not open external viewer: {}", e))?;
        return if status.success() {
            Ok(())
        } else {
            Err(format!("External viewer exited with status {}", status))
        };
    }

    #[cfg(not(any(unix, windows)))]
    {
        Err("External file opening is not supported on this platform".to_string())
    }
}

// ---------------------------------------------------------------------------
// Key → PTY byte conversion
// ---------------------------------------------------------------------------

fn key_to_bytes(key: KeyEvent) -> Vec<u8> {
    let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
    let alt = key.modifiers.contains(KeyModifiers::ALT);

    if ctrl {
        match key.code {
            KeyCode::Char(c) if c.is_ascii_lowercase() => {
                let mut v = Vec::with_capacity(2);
                if alt {
                    v.push(0x1b);
                }
                v.push((c as u8) - b'a' + 1);
                return v;
            }
            KeyCode::Char('[') => return vec![0x1b],
            KeyCode::Char(']') => return vec![0x1d],
            KeyCode::Char('\\') => return vec![0x1c],
            _ => {}
        }
    }

    let base: Vec<u8> = match key.code {
        KeyCode::Char(c) => {
            let mut buf = [0u8; 4];
            let s = c.encode_utf8(&mut buf);
            s.as_bytes().to_vec()
        }
        KeyCode::Enter => vec![b'\r'],
        KeyCode::Backspace => vec![0x7f],
        KeyCode::Tab => vec![b'\t'],
        KeyCode::Esc => vec![0x1b],
        KeyCode::Up => b"\x1b[A".to_vec(),
        KeyCode::Down => b"\x1b[B".to_vec(),
        KeyCode::Right => b"\x1b[C".to_vec(),
        KeyCode::Left => b"\x1b[D".to_vec(),
        KeyCode::Home => b"\x1b[H".to_vec(),
        KeyCode::End => b"\x1b[F".to_vec(),
        KeyCode::PageUp => b"\x1b[5~".to_vec(),
        KeyCode::PageDown => b"\x1b[6~".to_vec(),
        KeyCode::Delete => b"\x1b[3~".to_vec(),
        KeyCode::Insert => b"\x1b[2~".to_vec(),
        KeyCode::F(n) => match n {
            1 => b"\x1bOP".to_vec(),
            2 => b"\x1bOQ".to_vec(),
            3 => b"\x1bOR".to_vec(),
            4 => b"\x1bOS".to_vec(),
            5 => b"\x1b[15~".to_vec(),
            6 => b"\x1b[17~".to_vec(),
            7 => b"\x1b[18~".to_vec(),
            8 => b"\x1b[19~".to_vec(),
            9 => b"\x1b[20~".to_vec(),
            10 => b"\x1b[21~".to_vec(),
            11 => b"\x1b[23~".to_vec(),
            12 => b"\x1b[24~".to_vec(),
            _ => vec![],
        },
        _ => vec![],
    };

    // Alt = Meta: prefix with ESC for plain chars and Tab/Backspace/Enter so
    // readline-style bindings (M-f, M-b, M-., M-Backspace, M-d, …) work.
    // Don't prefix sequences that already start with ESC (arrows, F-keys,
    // Esc itself), which would create ambiguous double-ESC streams.
    if alt && !base.is_empty() && base[0] != 0x1b {
        let mut v = Vec::with_capacity(base.len() + 1);
        v.push(0x1b);
        v.extend_from_slice(&base);
        return v;
    }
    base
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn app_test_dir(name: &str) -> std::path::PathBuf {
        static NEXT_TEST_DIR: AtomicUsize = AtomicUsize::new(0);
        let root = std::env::temp_dir().join(format!(
            "fs-code-app-{}-{}-{}",
            name,
            std::process::id(),
            NEXT_TEST_DIR.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    fn open_dirty_file_with_disk_change(app: &mut App, content: &str, disk_content: &str) -> std::path::PathBuf {
        let root = app_test_dir("file-conflict");
        let file = root.join("conflict.txt");
        std::fs::write(&file, content).unwrap();
        let path = file.to_str().unwrap();

        app.open_file_from_files_ui(path);
        app.editor.insert_char('X');
        std::fs::write(&file, disk_content).unwrap();
        app.open_file_from_files_ui(path);

        file
    }

    #[test]
    fn parse_default_agent_number_recognizes_default_names() {
        assert_eq!(parse_default_agent_number("Agent 1"), Some(1));
        assert_eq!(parse_default_agent_number("Agent 12"), Some(12));
        assert_eq!(parse_default_agent_number("agent 1"), None);
        assert_eq!(parse_default_agent_number("main"), None);
        assert_eq!(parse_default_agent_number("Agent"), None);
        assert_eq!(parse_default_agent_number("Agent x"), None);
    }

    #[test]
    fn rename_agent_caps_at_max_and_handles_backspace() {
        let mut r = RenameAgent::new();
        r.open(0, "");
        for c in "abcdefghij".chars() {
            r.input_char(c);
        }
        // input_char must not exceed MAX_AGENT_NAME_LEN chars.
        assert_eq!(r.input.chars().count(), MAX_AGENT_NAME_LEN);
        assert_eq!(r.input, "abcdefgh");
        r.backspace();
        assert_eq!(r.input, "abcdefg");
        // Control chars are rejected.
        r.input_char('\n');
        r.input_char('\t');
        assert_eq!(r.input, "abcdefg");
    }

    #[test]
    fn rename_agent_backspace_handles_multibyte_chars() {
        let mut r = RenameAgent::new();
        r.open(0, "");
        r.input_char('ñ');
        r.input_char('日');
        assert_eq!(r.input.chars().count(), 2);
        r.backspace();
        assert_eq!(r.input.chars().count(), 1);
        assert_eq!(r.input, "ñ");
    }

    #[test]
    fn rename_agent_truncates_long_initial_name_on_open() {
        let mut r = RenameAgent::new();
        r.open(3, "this-is-way-too-long");
        assert_eq!(r.input.chars().count(), MAX_AGENT_NAME_LEN);
        assert_eq!(r.agent_idx, 3);
    }

    #[test]
    fn image_file_detection_is_case_insensitive() {
        assert!(is_image_file("asset/photo.png"));
        assert!(is_image_file("asset/photo.JPG"));
        assert!(is_image_file("asset/icon.SVG"));
        assert!(is_image_file("asset/preview.webp"));
        assert!(!is_image_file("src/main.rs"));
        assert!(!is_image_file("README"));
    }

    #[test]
    fn file_open_target_routes_images_externally() {
        assert_eq!(file_open_target("asset/photo.png"), FileOpenTarget::External);
        assert_eq!(file_open_target("src/main.rs"), FileOpenTarget::Editor);
    }

    #[test]
    fn utf8_read_errors_can_fallback_to_external() {
        let root = std::env::temp_dir().join(format!(
            "fs-code-app-open-target-test-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let file = root.join("binary-file");
        std::fs::write(&file, [0xff, 0xfe, 0xfd]).unwrap();

        assert!(should_fallback_to_external(
            file.to_str().unwrap(),
            "stream did not contain valid UTF-8"
        ));
        assert!(!should_fallback_to_external(
            file.to_str().unwrap(),
            "No such file or directory"
        ));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn dirty_disk_change_opens_file_conflict_modal() {
        let mut app = App::new();
        let file = open_dirty_file_with_disk_change(&mut app, "local\n", "external\n");

        assert_eq!(app.overlay, Overlay::FileConflict);
        assert_eq!(
            app.file_conflict.as_ref().map(|c| c.path.as_str()),
            Some(file.to_str().unwrap())
        );
        assert!(app.editor.dirty);
        assert_eq!(app.editor.content(), "Xlocal\n");

        let _ = std::fs::remove_dir_all(file.parent().unwrap());
    }

    #[test]
    fn file_conflict_reload_discards_buffer_after_choice() {
        let mut app = App::new();
        let file = open_dirty_file_with_disk_change(&mut app, "local\n", "external\n");

        app.handle_key(KeyEvent::new(KeyCode::Char('2'), KeyModifiers::NONE)).unwrap();

        assert_eq!(app.overlay, Overlay::Editor);
        assert!(app.file_conflict.is_none());
        assert!(!app.editor.dirty);
        assert_eq!(app.editor.content(), "external\n");

        let _ = std::fs::remove_dir_all(file.parent().unwrap());
    }

    #[test]
    fn file_conflict_diff_preserves_buffer() {
        let mut app = App::new();
        let file = open_dirty_file_with_disk_change(&mut app, "local\n", "external\n");

        app.handle_key(KeyEvent::new(KeyCode::Char('3'), KeyModifiers::NONE)).unwrap();

        assert_eq!(app.overlay, Overlay::Diff);
        assert!(app.file_conflict.is_none());
        assert!(app.editor.dirty);
        assert_eq!(app.editor.content(), "Xlocal\n");

        let _ = std::fs::remove_dir_all(file.parent().unwrap());
    }

    #[test]
    fn ctrl_q_requires_confirmation_before_quitting() {
        let mut app = App::new();
        let ctrl_q = KeyEvent::new(KeyCode::Char('q'), KeyModifiers::CONTROL);

        app.handle_key(ctrl_q).unwrap();
        assert_eq!(app.overlay, Overlay::QuitConfirm);
        assert!(!app.should_quit);

        app.handle_key(ctrl_q).unwrap();
        assert!(app.should_quit);
    }

    #[test]
    fn quit_confirmation_can_be_cancelled() {
        let mut app = App::new();
        let ctrl_q = KeyEvent::new(KeyCode::Char('q'), KeyModifiers::CONTROL);

        app.handle_key(ctrl_q).unwrap();
        app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)).unwrap();
        assert_eq!(app.overlay, Overlay::QuitConfirm);
        assert!(!app.should_quit);

        app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)).unwrap();

        assert_eq!(app.overlay, Overlay::None);
        assert!(!app.should_quit);
    }
}
