//! Main application state and event loop.

use std::collections::HashMap;
use std::io;
use std::time::Duration;

use crossterm::event::{self, Event, KeyCode, KeyEvent, KeyModifiers};
use crossterm::terminal::{self, EnterAlternateScreen, LeaveAlternateScreen};
use crossterm::ExecutableCommand;
use ratatui::prelude::*;

use fs_agent;
use fs_core::{uid, AgentDescriptor, AgentId, Config, KeyAction};
use fs_pty::TerminalManager;

use crate::diff::DiffViewer;
use crate::editor::Editor;
use crate::file_picker::{FilePicker, PickerMode};
use crate::grid;
use crate::palette::Palette;
use crate::render;

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
}

// ---------------------------------------------------------------------------
// AppState
// ---------------------------------------------------------------------------

pub struct App {
    agents: Vec<AgentDescriptor>,
    terminal_mgr: TerminalManager,
    /// Maps agent ID → terminal ID
    agent_terminals: HashMap<AgentId, String>,
    focused: usize,
    config: Config,
    palette: Palette,
    file_picker: FilePicker,
    editor: Editor,
    diff_viewer: DiffViewer,
    overlay: Overlay,
    /// Status message shown briefly in the status bar
    status_msg: Option<(String, std::time::Instant)>,
    should_quit: bool,
}

impl App {
    pub fn new() -> Self {
        Self {
            agents: Vec::new(),
            terminal_mgr: TerminalManager::new(),
            agent_terminals: HashMap::new(),
            focused: 0,
            config: Config::default(),
            palette: Palette::new(),
            file_picker: FilePicker::new(),
            editor: Editor::new(),
            diff_viewer: DiffViewer::new(),
            overlay: Overlay::None,
            status_msg: None,
            should_quit: false,
        }
    }

    /// Main entry point — sets up terminal, runs event loop, restores terminal.
    pub async fn run(&mut self) -> anyhow::Result<()> {
        terminal::enable_raw_mode()?;
        io::stdout().execute(EnterAlternateScreen)?;
        let backend = CrosstermBackend::new(io::stdout());
        let mut term = Terminal::new(backend)?;
        term.clear()?;

        let result = self.event_loop(&mut term).await;

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
            Event::Resize(cols, rows) => self.handle_resize(cols, rows)?,
            Event::Mouse(_) => {}
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
            Overlay::None => {}
        }

        let action = Self::map_key(key);

        match action {
            KeyAction::Quit => self.should_quit = true,
            KeyAction::NewAgent => self.add_agent()?,
            KeyAction::CloseAgent => self.close_focused_agent(),
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
                // Check for new overlay shortcuts before forwarding to terminal
                let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
                match (ctrl, key.code) {
                    (true, KeyCode::Char('o')) => {
                        let cwd = self.current_cwd();
                        self.file_picker.open(&cwd, PickerMode::Open);
                        self.overlay = Overlay::FilePicker;
                    }
                    (true, KeyCode::Char('d')) => {
                        let cwd = self.current_cwd();
                        self.file_picker.open(&cwd, PickerMode::Diff);
                        self.overlay = Overlay::FilePicker;
                    }
                    (true, KeyCode::Char('r')) => {
                        self.replace_focused_agent()?;
                    }
                    _ => {
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

        match key.code {
            KeyCode::Tab if !ctrl => KeyAction::FocusNext,
            KeyCode::BackTab => KeyAction::FocusPrev,
            _ => KeyAction::None,
        }
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
                        "replace" => self.replace_focused_agent()?,
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

        match (ctrl, key.code) {
            (_, KeyCode::Esc) => {
                self.editor.close();
                self.overlay = Overlay::None;
            }
            (true, KeyCode::Char('s')) => {
                match self.editor.save() {
                    Ok(()) => self.set_status("Saved"),
                    Err(e) => self.set_status(format!("Save failed: {}", e)),
                }
            }
            (false, KeyCode::Up) => self.editor.move_up(),
            (false, KeyCode::Down) => self.editor.move_down(),
            (false, KeyCode::Left) => self.editor.move_left(),
            (false, KeyCode::Right) => self.editor.move_right(),
            (false, KeyCode::Home) => self.editor.move_home(),
            (false, KeyCode::End) => self.editor.move_end(),
            (false, KeyCode::PageUp) => self.editor.page_up(),
            (false, KeyCode::PageDown) => self.editor.page_down(),
            (false, KeyCode::Enter) => self.editor.insert_newline(),
            (false, KeyCode::Backspace) => self.editor.backspace(),
            (false, KeyCode::Delete) => self.editor.delete_char(),
            (false, KeyCode::Tab) => self.editor.insert_char('\t'),
            (false, KeyCode::Char(c)) => self.editor.insert_char(c),
            _ => {}
        }
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Overlay: Diff Viewer
    // -----------------------------------------------------------------------

    fn handle_diff_key(&mut self, key: KeyEvent) -> anyhow::Result<()> {
        match key.code {
            KeyCode::Esc | KeyCode::Char('q') => {
                self.diff_viewer.close();
                self.overlay = Overlay::None;
            }
            KeyCode::Up | KeyCode::Char('k') => self.diff_viewer.scroll_up(1),
            KeyCode::Down | KeyCode::Char('j') => self.diff_viewer.scroll_down(1),
            KeyCode::PageUp => self.diff_viewer.scroll_up(20),
            KeyCode::PageDown => self.diff_viewer.scroll_down(20),
            KeyCode::Left | KeyCode::Char('h') => self.diff_viewer.prev_file(),
            KeyCode::Right | KeyCode::Char('l') => self.diff_viewer.next_file(),
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
        let areas = grid::compute_grid(
            Rect::new(0, 0, cols, rows.saturating_sub(1)),
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

        self.terminal_mgr.create(
            terminal_id.clone(),
            &program,
            &args,
            &cwd,
            env,
            80,
            24,
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
        self.set_status("Agent created");
        Ok(())
    }

    /// Close the focused agent and remove its pane.
    fn close_focused_agent(&mut self) {
        if self.agents.is_empty() {
            return;
        }

        let idx = self.focused;
        let agent = self.agents.remove(idx);
        let name = agent.name.clone();

        if let Some(tid) = self.agent_terminals.remove(&agent.id) {
            self.terminal_mgr.close(&tid);
        }

        if !self.agents.is_empty() {
            self.focused = self.focused.min(self.agents.len() - 1);
        } else {
            self.focused = 0;
        }
        self.set_status(format!("{} closed", name));
    }

    /// Replace the focused agent — close it and spawn a fresh one in its slot.
    fn replace_focused_agent(&mut self) -> anyhow::Result<()> {
        if self.agents.is_empty() {
            return self.add_agent();
        }

        let idx = self.focused;
        let old = self.agents.remove(idx);
        let cwd = old.cwd.clone();

        if let Some(tid) = self.agent_terminals.remove(&old.id) {
            self.terminal_mgr.close(&tid);
        }

        // Create replacement
        let id = uid();
        let terminal_id = uid();
        let name = old.name.clone();

        let (program, args) = if let Some(cli) = fs_agent::find_claude_cli() {
            (
                cli.to_string_lossy().to_string(),
                fs_agent::claude_args(None),
            )
        } else {
            (self.config.default_shell.clone(), vec![])
        };

        let env = fs_agent::build_clean_env();

        self.terminal_mgr.create(
            terminal_id.clone(),
            &program,
            &args,
            &cwd,
            env,
            80,
            24,
        )?;

        self.agent_terminals.insert(id.clone(), terminal_id.clone());
        let desc = AgentDescriptor {
            id,
            name: name.clone(),
            cwd,
            is_active: true,
            provider: "claude".into(),
        };
        self.agents.insert(idx, desc);
        self.focused = idx;
        self.set_status(format!("{} replaced", name));
        Ok(())
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

        // Split: main area + 1-row status bar at bottom
        let chunks = Layout::default()
            .direction(Direction::Vertical)
            .constraints([Constraint::Min(1), Constraint::Length(1)])
            .split(area);

        let main_area = chunks[0];
        let status_area = chunks[1];

        if self.agents.is_empty() {
            render::render_welcome(frame, main_area);
        } else {
            let pane_areas = grid::compute_grid(main_area, self.agents.len());
            for (i, agent) in self.agents.iter().enumerate() {
                if let Some(&pane_area) = pane_areas.get(i) {
                    let is_focused = i == self.focused;
                    let terminal_id = self.agent_terminals.get(&agent.id);
                    let instance =
                        terminal_id.and_then(|tid| self.terminal_mgr.get(tid));
                    render::render_pane(frame, pane_area, agent, is_focused, instance);
                }
            }
        }

        render::render_status_bar(
            frame,
            status_area,
            &self.agents,
            self.focused,
            self.status_msg.as_ref().map(|(m, _)| m.as_str()),
        );

        // Overlays (rendered on top of everything)
        match self.overlay {
            Overlay::Palette => self.palette.render(frame, area),
            Overlay::FilePicker => self.file_picker.render(frame, area),
            Overlay::Editor => self.editor.render(frame, main_area),
            Overlay::Diff => self.diff_viewer.render(frame, main_area),
            Overlay::None => {}
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
