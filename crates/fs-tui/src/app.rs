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

use crate::grid;
use crate::palette::Palette;
use crate::render;

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
            should_quit: false,
        }
    }

    /// Main entry point — sets up terminal, runs event loop, restores terminal.
    pub async fn run(&mut self) -> anyhow::Result<()> {
        // Setup terminal
        terminal::enable_raw_mode()?;
        io::stdout().execute(EnterAlternateScreen)?;
        let backend = CrosstermBackend::new(io::stdout());
        let mut term = Terminal::new(backend)?;
        term.clear()?;

        // Event loop
        let result = self.event_loop(&mut term).await;

        // Restore terminal
        terminal::disable_raw_mode()?;
        io::stdout().execute(LeaveAlternateScreen)?;

        // Cleanup all PTYs
        self.terminal_mgr.close_all();

        result
    }

    async fn event_loop(&mut self, term: &mut Terminal<CrosstermBackend<io::Stdout>>) -> anyhow::Result<()> {
        loop {
            // Render
            term.draw(|frame| self.render(frame))?;

            if self.should_quit {
                break;
            }

            // Poll for events (16ms ≈ 60fps)
            if event::poll(Duration::from_millis(16))? {
                let ev = event::read()?;
                self.handle_event(ev)?;
            }
        }
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Event handling
    // -----------------------------------------------------------------------

    fn handle_event(&mut self, ev: Event) -> anyhow::Result<()> {
        match ev {
            Event::Key(key) => self.handle_key(key)?,
            Event::Resize(cols, rows) => self.handle_resize(cols, rows)?,
            Event::Mouse(_) => {} // MVP: no mouse support yet
            _ => {}
        }
        Ok(())
    }

    fn handle_key(&mut self, key: KeyEvent) -> anyhow::Result<()> {
        // If palette is open, route keys there
        if self.palette.is_open() {
            return self.handle_palette_key(key);
        }

        let action = Self::map_key(key);

        match action {
            KeyAction::Quit => {
                self.should_quit = true;
            }
            KeyAction::NewAgent => {
                self.add_agent()?;
            }
            KeyAction::CloseAgent => {
                self.close_focused_agent();
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
                    self.focused = (self.focused + self.agents.len() - 1) % self.agents.len();
                }
            }
            KeyAction::TogglePalette => {
                self.palette.toggle();
            }
            KeyAction::None => {
                // Forward keypress to the focused terminal
                self.forward_key_to_terminal(key)?;
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

        // Convert crossterm key event to bytes for the PTY
        let bytes = key_to_bytes(key);
        if !bytes.is_empty() {
            instance.write(&bytes)?;
        }
        Ok(())
    }

    fn handle_palette_key(&mut self, key: KeyEvent) -> anyhow::Result<()> {
        match key.code {
            KeyCode::Esc => self.palette.close(),
            KeyCode::Enter => {
                if let Some(cmd) = self.palette.execute() {
                    match cmd.as_str() {
                        "new" => self.add_agent()?,
                        "close" => self.close_focused_agent(),
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

    fn handle_resize(&mut self, cols: u16, rows: u16) -> anyhow::Result<()> {
        // Recompute pane sizes and resize all terminals
        let areas = grid::compute_grid(
            Rect::new(0, 0, cols, rows.saturating_sub(1)), // leave 1 row for status
            self.agents.len(),
        );

        for (i, agent) in self.agents.iter().enumerate() {
            if let Some(area) = areas.get(i) {
                let pane_rows = area.height.saturating_sub(1); // 1 row for header
                let pane_cols = area.width;
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
            return Ok(()); // silently refuse if at cap
        }

        let cwd = std::env::current_dir()?
            .to_string_lossy()
            .to_string();
        let id = uid();
        let terminal_id = uid();
        let name = format!("Agent {}", self.agents.len() + 1);

        // Determine program and args
        let (program, args) = if let Some(cli) = fs_agent::find_claude_cli() {
            (cli.to_string_lossy().to_string(), fs_agent::claude_args(None))
        } else {
            // Fallback to shell if claude not found
            (self.config.default_shell.clone(), vec![])
        };

        let env = fs_agent::build_clean_env();

        self.terminal_mgr.create(
            terminal_id.clone(),
            &program,
            &args,
            &cwd,
            env,
            80, // initial size, will be resized on next render
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
        Ok(())
    }

    fn close_focused_agent(&mut self) {
        if self.agents.is_empty() {
            return;
        }

        let idx = self.focused;
        let agent = self.agents.remove(idx);

        if let Some(tid) = self.agent_terminals.remove(&agent.id) {
            self.terminal_mgr.close(&tid);
        }

        if !self.agents.is_empty() {
            self.focused = self.focused.min(self.agents.len() - 1);
        } else {
            self.focused = 0;
        }
    }

    // -----------------------------------------------------------------------
    // Rendering
    // -----------------------------------------------------------------------

    fn render(&self, frame: &mut Frame) {
        let area = frame.area();

        // Split: main area + 1-row status bar at bottom
        let chunks = Layout::default()
            .direction(Direction::Vertical)
            .constraints([
                Constraint::Min(1),
                Constraint::Length(1),
            ])
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
                    let instance = terminal_id.and_then(|tid| self.terminal_mgr.get(tid));
                    render::render_pane(frame, pane_area, agent, is_focused, instance);
                }
            }
        }

        render::render_status_bar(frame, status_area, &self.agents, self.focused);

        // Command palette overlay
        if self.palette.is_open() {
            self.palette.render(frame, area);
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
                // Ctrl+a = 0x01, Ctrl+b = 0x02, etc.
                return vec![(c as u8) - b'a' + 1];
            }
            KeyCode::Char('[') => return vec![0x1b], // Escape
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
