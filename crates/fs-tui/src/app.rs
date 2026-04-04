//! Main application state and event loop.

use std::collections::HashMap;
use std::io;
use std::time::Duration;

use alacritty_terminal::grid::Dimensions;
use crossterm::event::{self, Event, KeyCode, KeyEvent, KeyboardEnhancementFlags, KeyModifiers, MouseEvent, MouseEventKind, PushKeyboardEnhancementFlags, PopKeyboardEnhancementFlags, EnableBracketedPaste, DisableBracketedPaste};
use crossterm::terminal::{self, EnterAlternateScreen, LeaveAlternateScreen};
use crossterm::event::{DisableMouseCapture, EnableMouseCapture};
use crossterm::ExecutableCommand;
use ratatui::prelude::*;

use fs_agent;
use fs_core::{uid, AgentDescriptor, AgentId, Config, KeyAction};
use fs_pty::TerminalManager;

use crate::deps::DepsViewer;
use crate::diff::DiffViewer;
use crate::editor::Editor;
use crate::file_picker::{FilePicker, PickerMode};
use crate::file_tree::{FileTree, SIDEBAR_WIDTH};
use crate::grid;
use crate::palette::Palette;
use crate::render;
use crate::theme::{self, Theme, ThemeMode};

// ---------------------------------------------------------------------------
// Active overlay — only one overlay can be open at a time
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq)]
enum Overlay {
    None,
    Palette,
    FilePicker,
    Editor,
    Diff,
    Deps,
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
}

impl App {
    pub fn new() -> Self {
        Self {
            agents: Vec::new(),
            terminal_mgr: TerminalManager::new(),
            agent_terminals: HashMap::new(),
            scroll_offsets: HashMap::new(),
            focused: 0,
            config: Config::default(),
            palette: Palette::new(),
            file_picker: FilePicker::new(),
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
        loop {
            term.draw(|frame| self.render(frame))?;

            if self.should_quit {
                break;
            }

            // Expire status messages after 3 seconds
            if let Some((_, at)) = &self.status_msg {
                if at.elapsed() > Duration::from_secs(3) {
                    self.status_msg = None;
                }
            }

            if event::poll(Duration::from_millis(16))? {
                let ev = event::read()?;
                self.handle_event(ev)?;
            }
        }
        Ok(())
    }

    fn set_status(&mut self, msg: impl Into<String>) {
        self.status_msg = Some((msg.into(), std::time::Instant::now()));
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
                self.editor.insert_text(text);
            }
            Overlay::Palette => {
                // Insert into palette search box (strip newlines)
                for c in text.chars().filter(|c| *c != '\n' && *c != '\r') {
                    self.palette.input(c);
                }
            }
            Overlay::FilePicker => {
                for c in text.chars().filter(|c| *c != '\n' && *c != '\r') {
                    self.file_picker.input(c);
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

    fn handle_mouse(&mut self, mouse: MouseEvent) -> anyhow::Result<()> {
        match mouse.kind {
            MouseEventKind::ScrollUp | MouseEventKind::ScrollDown => {
                let delta = if mouse.kind == MouseEventKind::ScrollUp { -3 } else { 3 };
                if self.overlay == Overlay::Diff {
                    if delta < 0 {
                        self.diff_viewer.scroll_up((-delta) as usize);
                    } else {
                        self.diff_viewer.scroll_down(delta as usize);
                    }
                } else if self.overlay == Overlay::None && !self.agents.is_empty() {
                    // Focus whichever pane the cursor is over, then scroll it
                    let (term_cols, term_rows) = terminal::size().unwrap_or((80, 24));
                    let main_area = Rect::new(0, 0, term_cols, term_rows.saturating_sub(1));
                    let pane_areas = grid::compute_grid(main_area, self.agents.len());
                    let hovered = pane_areas.iter().position(|a| {
                        mouse.column >= a.x && mouse.column < a.x + a.width
                            && mouse.row >= a.y && mouse.row < a.y + a.height
                    });
                    if let Some(idx) = hovered {
                        self.focused = idx;
                    }
                    self.scroll_focused(delta);
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
            Overlay::Editor => return self.handle_editor_key(key),
            Overlay::Diff => return self.handle_diff_key(key),
            Overlay::Deps => return self.handle_deps_key(key),
            Overlay::None => {}
        }

        // Sidebar gets keys when it has focus
        if self.sidebar_focused {
            return self.handle_sidebar_key(key);
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
            KeyAction::Quit => self.should_quit = true,
            KeyAction::NewAgent => self.add_agent()?,
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
                    self.focused = idx;
                }
            }
            KeyAction::FocusNext => {
                if !self.agents.is_empty() {
                    self.focused = (self.focused + 1) % self.agents.len();
                }
            }
            KeyAction::FocusPrev => {
                if !self.agents.is_empty() {
                    self.focused =
                        (self.focused + self.agents.len() - 1) % self.agents.len();
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
                    _ => {
                        // Any regular keypress snaps back to live view
                        if let Some(agent) = self.agents.get(self.focused) {
                            self.scroll_offsets.insert(agent.id.clone(), 0);
                        }
                        self.forward_key_to_terminal(key)?;
                    }
                }
            }
        }
        Ok(())
    }

    fn map_key(key: KeyEvent) -> KeyAction {
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);

        if ctrl {
            match key.code {
                KeyCode::Char('q') => return KeyAction::Quit,
                KeyCode::Char('n') => return KeyAction::NewAgent,
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
                    self.overlay = Overlay::None;
                    match cmd.as_str() {
                        "new" => self.add_agent()?,
                        "close" => self.close_focused_agent(),
                        "open" => {
                            let cwd = self.current_cwd();
                            self.file_picker.open(&cwd, PickerMode::Open);
                            self.overlay = Overlay::FilePicker;
                        }
                        "diff" => {
                            let cwd = self.current_cwd();
                            self.file_picker.open(&cwd, PickerMode::Diff);
                            self.overlay = Overlay::FilePicker;
                        }
                        "deps" => {
                            self.open_deps_viewer();
                        }
                        "quit" => self.should_quit = true,
                        _ => {}
                    }
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
                            match self.editor.open_file(&path) {
                                Ok(()) => {
                                    self.overlay = Overlay::Editor;
                                    self.set_status(format!("Opened {}", path));
                                }
                                Err(e) => self.set_status(format!("Error: {}", e)),
                            }
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
            _ => {}
        }
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Overlay: Editor
    // -----------------------------------------------------------------------

    fn handle_editor_key(&mut self, key: KeyEvent) -> anyhow::Result<()> {
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        let shift = key.modifiers.contains(KeyModifiers::SHIFT);

        match (ctrl, shift, key.code) {
            // Esc: unfocus editor, return focus to agents (panel stays open)
            (_, _, KeyCode::Esc) => {
                self.overlay = Overlay::None;
            }
            // Ctrl+W / Ctrl+X: close the editor panel entirely
            (true, _, KeyCode::Char('w')) | (true, _, KeyCode::Char('W'))
            | (true, _, KeyCode::Char('x')) | (true, _, KeyCode::Char('X')) => {
                self.editor.close();
                self.overlay = Overlay::None;
            }
            (true, _, KeyCode::Char('s')) => {
                match self.editor.save() {
                    Ok(()) => self.set_status("Saved"),
                    Err(e) => self.set_status(format!("Save failed: {}", e)),
                }
            }
            // Ctrl+D: delete line / Ctrl+Shift+D: duplicate line
            (true, true, KeyCode::Char('d')) | (true, true, KeyCode::Char('D')) => {
                self.editor.duplicate_line();
            }
            (true, false, KeyCode::Char('d')) => {
                self.editor.delete_line();
            }
            // Fast navigation — Ctrl+Arrow jumps by word / 5 lines
            (true, _, KeyCode::Up) => self.editor.jump_up(),
            (true, _, KeyCode::Down) => self.editor.jump_down(),
            (true, _, KeyCode::Left) => self.editor.word_left(),
            (true, _, KeyCode::Right) => self.editor.word_right(),
            // Ctrl+Home/End: top/bottom of file
            (true, _, KeyCode::Home) => self.editor.goto_top(),
            (true, _, KeyCode::End) => self.editor.goto_bottom(),
            // Normal movement
            (false, _, KeyCode::Up) => self.editor.move_up(),
            (false, _, KeyCode::Down) => self.editor.move_down(),
            (false, _, KeyCode::Left) => self.editor.move_left(),
            (false, _, KeyCode::Right) => self.editor.move_right(),
            (false, _, KeyCode::Home) => self.editor.move_home(),
            (false, _, KeyCode::End) => self.editor.move_end(),
            (false, _, KeyCode::PageUp) => self.editor.page_up(),
            (false, _, KeyCode::PageDown) => self.editor.page_down(),
            (false, _, KeyCode::Enter) => self.editor.insert_newline(),
            (false, _, KeyCode::Backspace) => self.editor.backspace(),
            (false, _, KeyCode::Delete) => self.editor.delete_char(),
            (false, _, KeyCode::Tab) => self.editor.insert_char('\t'),
            (false, _, KeyCode::Char(c)) => self.editor.insert_char(c),
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
                        Ok(()) => {
                            self.editor.goto_line(source_line);
                            self.overlay = Overlay::Editor;
                            self.set_status(format!("Editing {} :{}", path, source_line + 1));
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
    // Sidebar
    // -----------------------------------------------------------------------

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
            // Activate: expand dir or open file
            (_, KeyCode::Enter) | (_, KeyCode::Char(' ')) => {
                if let Some(path) = self.file_tree.activate_selected() {
                    let path_str = path.to_string_lossy().to_string();
                    match self.editor.open_file(&path_str) {
                        Ok(()) => {
                            self.sidebar_focused = false;
                            self.overlay = Overlay::Editor;
                            self.set_status(format!("Opened {}", path_str));
                        }
                        Err(e) => self.set_status(format!("Error: {}", e)),
                    }
                }
            }
            // 'e' — explicitly open selected file in editor
            (_, KeyCode::Char('e')) => {
                if let Some(path) = self.file_tree.selected_path() {
                    if !path.is_dir() {
                        let path_str = path.to_string_lossy().to_string();
                        match self.editor.open_file(&path_str) {
                            Ok(()) => {
                                self.sidebar_focused = false;
                                self.overlay = Overlay::Editor;
                                self.set_status(format!("Opened {}", path_str));
                            }
                            Err(e) => self.set_status(format!("Error: {}", e)),
                        }
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

    fn handle_resize(&mut self, cols: u16, rows: u16) -> anyhow::Result<()> {
        let sidebar_w = if self.sidebar_open { SIDEBAR_WIDTH } else { 0 };
        let available_cols = cols.saturating_sub(sidebar_w);
        let areas = grid::compute_grid(
            Rect::new(0, 0, available_cols, rows.saturating_sub(1)),
            self.agents.len(),
        );

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
    fn scroll_focused(&mut self, delta: i32) {
        let Some(agent) = self.agents.get(self.focused) else { return };
        let terminal_id = match self.agent_terminals.get(&agent.id) {
            Some(tid) => tid.clone(),
            None => return,
        };
        let Some(instance) = self.terminal_mgr.get(&terminal_id) else { return };
        let max_scroll = instance.term.lock()
            .map(|t| t.grid().history_size())
            .unwrap_or(0);

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

    fn add_agent(&mut self) -> anyhow::Result<()> {
        if self.agents.len() >= self.config.max_agents {
            self.set_status(format!("Max {} agents reached", self.config.max_agents));
            return Ok(());
        }

        let cwd = std::env::current_dir()?
            .to_string_lossy()
            .to_string();
        let id = uid();
        let terminal_id = uid();
        let name = format!("Agent {}", self.agents.len() + 1);

        let (program, args) = if let Some(cli) = fs_agent::find_claude_cli() {
            (
                cli.to_string_lossy().to_string(),
                fs_agent::claude_args(None),
            )
        } else {
            (self.config.default_shell.clone(), vec![])
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
        self.agents.push(AgentDescriptor {
            id,
            name,
            cwd,
            is_active: true,
            provider: "claude".into(),
        });

        self.focused = self.agents.len() - 1;

        // Resize all panes (existing + new) to fit the updated grid layout.
        let (term_cols, term_rows) = terminal::size().unwrap_or((80, 24));
        self.handle_resize(term_cols, term_rows)?;

        self.set_status("Agent created");
        Ok(())
    }

    /// Close the focused agent and remove its pane, renumbering the rest.
    fn close_focused_agent(&mut self) {
        if self.agents.is_empty() {
            return;
        }

        let idx = self.focused;
        let agent = self.agents.remove(idx);

        if let Some(tid) = self.agent_terminals.remove(&agent.id) {
            self.terminal_mgr.close(&tid);
        }
        self.scroll_offsets.remove(&agent.id);

        // Renumber remaining agents
        for (i, a) in self.agents.iter_mut().enumerate() {
            a.name = format!("Agent {}", i + 1);
        }

        if !self.agents.is_empty() {
            self.focused = self.focused.min(self.agents.len() - 1);
            // Resize remaining panes to fill the now-larger grid slots.
            let (term_cols, term_rows) = terminal::size().unwrap_or((80, 24));
            self.handle_resize(term_cols, term_rows).ok();
        } else {
            self.focused = 0;
        }
        self.set_status("Agent closed");
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

    // -----------------------------------------------------------------------
    // Rendering
    // -----------------------------------------------------------------------

    fn render(&mut self, frame: &mut Frame) {
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

        // Split content: agent grid on left, editor panel on right (when open)
        let (agent_area, editor_panel_area) = if self.editor.is_open() {
            let h = Layout::default()
                .direction(Direction::Horizontal)
                .constraints([Constraint::Percentage(55), Constraint::Percentage(45)])
                .split(content_area);
            (h[0], Some(h[1]))
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
                    render::render_pane(frame, pane_area, agent, is_focused, instance, scroll, &self.theme);
                }
            }
        }

        // Render editor side panel (always visible when a file is open)
        if let Some(ea) = editor_panel_area {
            self.editor.render(frame, ea, self.overlay == Overlay::Editor, &self.theme);
        }

        let hint = match self.overlay {
            Overlay::Editor =>
                " ^S save │ ^W close │ Esc unfocus editor ",
            Overlay::Diff =>
                " ↑↓/jk scroll │ ←→/hl prev/next file │ e edit │ q close ",
            Overlay::FilePicker =>
                " ↑↓ navigate │ Enter open │ Esc cancel ",
            Overlay::Palette =>
                " ↑↓ navigate │ Enter run │ Esc cancel ",
            Overlay::Deps =>
                " Tab switch │ j/k scroll │ PgUp/Dn │ q/Esc close ",
            Overlay::None if self.sidebar_focused =>
                " ↑↓/jk navigate │ Enter expand/open │ e edit │ d diff │ i deps │ r refresh │ Esc unfocus ",
            Overlay::None if self.editor.is_open() =>
                " ^F focus editor │ ^W close │ Tab cycle │ ^E tree │ ^D diff │ ^I deps │ ^K palette ",
            Overlay::None =>
                " ^N new │ ^W close │ Tab cycle │ ^E tree │ ^O open │ ^D diff │ ^I deps │ ^K palette │ ^Q quit ",
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
            Overlay::Editor     => {} // rendered inline as side panel above
            Overlay::Diff       => self.diff_viewer.render(frame, main_area, &self.theme),
            Overlay::Deps       => self.deps_viewer.render(frame, main_area, &self.theme),
            Overlay::None       => {}
        }
    }
}

// ---------------------------------------------------------------------------
// Key → PTY byte conversion
// ---------------------------------------------------------------------------

fn key_to_bytes(key: KeyEvent) -> Vec<u8> {
    let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);

    if ctrl {
        match key.code {
            KeyCode::Char(c) if c.is_ascii_lowercase() => {
                return vec![(c as u8) - b'a' + 1];
            }
            KeyCode::Char('[') => return vec![0x1b],
            KeyCode::Char(']') => return vec![0x1d],
            KeyCode::Char('\\') => return vec![0x1c],
            _ => {}
        }
    }

    match key.code {
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
    }
}
