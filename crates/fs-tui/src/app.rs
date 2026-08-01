//! Terminal-tabs application state and event loop.

use std::io;
use std::time::{Duration, Instant};

use crossterm::event::{
    self, DisableBracketedPaste, DisableMouseCapture, EnableBracketedPaste, EnableMouseCapture,
    Event, KeyCode, KeyEvent, KeyModifiers, KeyboardEnhancementFlags, PopKeyboardEnhancementFlags,
    PushKeyboardEnhancementFlags,
};
use crossterm::terminal::{self, EnterAlternateScreen, LeaveAlternateScreen};
use crossterm::ExecutableCommand;
use ratatui::prelude::*;
use ratatui::widgets::{Block, Borders, Clear, Paragraph};

use fs_core::{uid, AgentDescriptor, Provider};
use fs_pty::TerminalManager;

use crate::file_tree::{FileTree, SIDEBAR_WIDTH};
use crate::render;
use crate::theme::{self, Theme, ThemeMode};

const MAX_TABS: usize = 32;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Overlay {
    None,
    Rename,
    Quit,
}

struct RenameTab {
    value: String,
}

impl RenameTab {
    fn open(&mut self, value: &str) {
        self.value = value.to_owned();
    }
    fn clear(&mut self) {
        self.value.clear();
    }
    fn render(&self, frame: &mut Frame, area: Rect, theme: &Theme) {
        let width = 36.min(area.width.saturating_sub(4));
        let height = 5.min(area.height.saturating_sub(4));
        let rect = Rect::new(
            area.x + (area.width - width) / 2,
            area.y + (area.height - height) / 2,
            width,
            height,
        );
        frame.render_widget(Clear, rect);
        let block = Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(theme.text))
            .title(" Rename tab ");
        let inner = block.inner(rect);
        frame.render_widget(block, rect);
        frame.render_widget(
            Paragraph::new(format!("{}|", self.value)).style(Style::default().fg(theme.text)),
            inner,
        );
    }
}

pub struct App {
    tabs: Vec<AgentDescriptor>,
    terminal_mgr: TerminalManager,
    focused: usize,
    tree: FileTree,
    tree_open: bool,
    tree_focused: bool,
    overlay: Overlay,
    rename: RenameTab,
    status: Option<(String, Instant)>,
    should_quit: bool,
    theme: Theme,
    last_revisions: std::collections::HashMap<String, u64>,
}

impl App {
    pub fn new() -> Self {
        let cwd = std::env::current_dir()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let mut tree = FileTree::new();
        tree.load(&cwd);
        Self {
            tabs: Vec::new(),
            terminal_mgr: TerminalManager::new(),
            focused: 0,
            tree,
            tree_open: false,
            tree_focused: false,
            overlay: Overlay::None,
            rename: RenameTab {
                value: String::new(),
            },
            status: None,
            should_quit: false,
            theme: theme::theme(ThemeMode::default()),
            last_revisions: Default::default(),
        }
    }

    pub async fn run(&mut self) -> anyhow::Result<()> {
        terminal::enable_raw_mode()?;
        let mut stdout = io::stdout();
        stdout.execute(EnterAlternateScreen)?;
        stdout.execute(EnableMouseCapture)?;
        stdout.execute(EnableBracketedPaste)?;
        let enhanced = terminal::supports_keyboard_enhancement().unwrap_or(false);
        if enhanced {
            stdout.execute(PushKeyboardEnhancementFlags(
                KeyboardEnhancementFlags::DISAMBIGUATE_ESCAPE_CODES,
            ))?;
        }
        let mut terminal = Terminal::new(CrosstermBackend::new(stdout))?;
        terminal.clear()?;
        let result = self.event_loop(&mut terminal);
        // Always reclaim tab resources before restoring the host terminal.
        self.terminal_mgr.close_all();
        if enhanced {
            io::stdout().execute(PopKeyboardEnhancementFlags)?;
        }
        io::stdout().execute(DisableBracketedPaste)?;
        io::stdout().execute(DisableMouseCapture)?;
        terminal::disable_raw_mode()?;
        io::stdout().execute(LeaveAlternateScreen)?;
        result
    }

    fn event_loop(
        &mut self,
        terminal: &mut Terminal<CrosstermBackend<io::Stdout>>,
    ) -> anyhow::Result<()> {
        let mut redraw = true;
        while !self.should_quit {
            redraw |= self.expire_status() | self.sync_revisions() | self.reap_exited_tabs();
            if redraw {
                terminal.draw(|frame| self.render(frame))?;
                redraw = false;
            }
            if event::poll(Duration::from_millis(50))? {
                self.handle_event(event::read()?)?;
                redraw = true;
            }
        }
        Ok(())
    }

    fn handle_event(&mut self, event: Event) -> anyhow::Result<()> {
        match event {
            Event::Key(key) if key.kind == crossterm::event::KeyEventKind::Press => {
                self.handle_key(key)
            }
            Event::Paste(text) => self.write_focused(text.as_bytes()),
            Event::Resize(_, _) => self.resize_focused(),
            _ => Ok(()),
        }
    }

    fn handle_key(&mut self, key: KeyEvent) -> anyhow::Result<()> {
        match self.overlay {
            Overlay::Rename => return self.handle_rename_key(key),
            Overlay::Quit => {
                if is_ctrl(key, 'q') || matches!(key.code, KeyCode::Char('y') | KeyCode::Char('Y'))
                {
                    self.should_quit = true;
                } else if matches!(
                    key.code,
                    KeyCode::Esc | KeyCode::Char('n') | KeyCode::Char('N')
                ) {
                    self.overlay = Overlay::None;
                }
                return Ok(());
            }
            Overlay::None => {}
        }
        if self.tree_focused {
            return self.handle_tree_key(key);
        }
        if is_ctrl(key, 'q') {
            self.overlay = Overlay::Quit;
            self.set_status("Ctrl+Q again to quit");
            return Ok(());
        }
        if is_ctrl(key, 'n') {
            return self.new_tab();
        }
        if is_ctrl(key, 'w') {
            self.close_focused();
            return Ok(());
        }
        if is_ctrl(key, 'r') || key.code == KeyCode::F(2) {
            self.open_rename();
            return Ok(());
        }
        if is_ctrl(key, 'e') {
            self.tree_open = !self.tree_open;
            self.tree_focused = self.tree_open;
            self.resize_focused()?;
            return Ok(());
        }
        if key.code == KeyCode::Tab || is_ctrl_arrow(key) {
            self.cycle(1);
            return Ok(());
        }
        if key.code == KeyCode::BackTab
            || (key.modifiers.contains(KeyModifiers::CONTROL)
                && matches!(key.code, KeyCode::Left | KeyCode::Up))
        {
            self.cycle(-1);
            return Ok(());
        }
        self.forward_key(key)
    }

    fn handle_tree_key(&mut self, key: KeyEvent) -> anyhow::Result<()> {
        if self.tree.is_input_active() {
            match key.code {
                KeyCode::Esc => self.tree.cancel_input(),
                KeyCode::Enter => match self.tree.confirm_input() {
                    Ok(Some(message)) => {
                        self.tree.refresh();
                        self.set_status(message);
                    }
                    Ok(None) => {}
                    Err(e) => self.set_status(e),
                },
                KeyCode::Backspace => self.tree.input_backspace(),
                KeyCode::Char(c) if !key.modifiers.contains(KeyModifiers::CONTROL) => {
                    self.tree.input_char(c)
                }
                _ => {}
            }
            return Ok(());
        }
        match key.code {
            KeyCode::Esc | KeyCode::Tab => self.tree_focused = false,
            KeyCode::Up | KeyCode::Char('k') => self.tree.move_up(),
            KeyCode::Down | KeyCode::Char('j') => self.tree.move_down(),
            KeyCode::Enter | KeyCode::Char(' ') => {
                self.tree.activate_selected();
            }
            KeyCode::Char('r') => self.tree.refresh(),
            KeyCode::Char('a') => self.tree.start_new_file(),
            KeyCode::Char('d') => self.tree.start_new_folder(),
            KeyCode::Char('m') => self.tree.start_rename(),
            _ if is_ctrl(key, 'e') => {
                self.tree_open = false;
                self.tree_focused = false;
                self.resize_focused()?;
            }
            _ => {}
        }
        Ok(())
    }

    fn handle_rename_key(&mut self, key: KeyEvent) -> anyhow::Result<()> {
        match key.code {
            KeyCode::Esc => {
                self.rename.clear();
                self.overlay = Overlay::None;
            }
            KeyCode::Enter => {
                let name = self.rename.value.trim().to_owned();
                if let Some(tab) = self.tabs.get_mut(self.focused) {
                    if !name.is_empty() {
                        tab.name = name;
                        self.set_status("Tab renamed");
                    }
                }
                self.rename.clear();
                self.overlay = Overlay::None;
            }
            KeyCode::Backspace => {
                self.rename.value.pop();
            }
            KeyCode::Char(c)
                if !key.modifiers.contains(KeyModifiers::CONTROL)
                    && self.rename.value.chars().count() < 32 =>
            {
                self.rename.value.push(c)
            }
            _ => {}
        }
        Ok(())
    }

    fn new_tab(&mut self) -> anyhow::Result<()> {
        if self.tabs.len() >= MAX_TABS {
            self.set_status("Maximum tab count reached");
            return Ok(());
        }
        let cwd = self.current_cwd();
        let terminal_id = uid();
        let shell = fs_agent::find_shell();
        self.terminal_mgr.create(
            terminal_id.clone(),
            &shell.to_string_lossy(),
            &fs_agent::shell_args(),
            &cwd,
            fs_agent::build_clean_env(),
            80,
            24,
        )?;
        let name = format!("Terminal {}", self.tabs.len() + 1);
        self.tabs.push(AgentDescriptor {
            id: terminal_id,
            name,
            cwd,
            provider: Provider::Terminal,
        });
        self.focused = self.tabs.len() - 1;
        self.resize_focused()?;
        self.set_status("New terminal tab");
        Ok(())
    }

    fn close_focused(&mut self) {
        if self.tabs.is_empty() {
            return;
        }
        let tab = self.tabs.remove(self.focused);
        self.last_revisions.remove(&tab.id);
        self.terminal_mgr.close(&tab.id);
        if self.focused >= self.tabs.len() && !self.tabs.is_empty() {
            self.focused = self.tabs.len() - 1;
        }
        if self.tabs.is_empty() {
            self.focused = 0;
        }
        self.set_status("Terminal tab closed");
    }

    fn cycle(&mut self, delta: i32) {
        if self.tabs.is_empty() {
            return;
        }
        self.focused = (self.focused as i32 + delta).rem_euclid(self.tabs.len() as i32) as usize;
        let _ = self.resize_focused();
    }

    fn open_rename(&mut self) {
        if let Some(tab) = self.tabs.get(self.focused) {
            self.rename.open(&tab.name);
            self.overlay = Overlay::Rename;
        }
    }

    fn current_cwd(&self) -> String {
        self.tabs
            .get(self.focused)
            .map(|t| t.cwd.clone())
            .unwrap_or_else(|| {
                std::env::current_dir()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string()
            })
    }

    fn forward_key(&mut self, key: KeyEvent) -> anyhow::Result<()> {
        let bytes: Option<Vec<u8>> = match key.code {
            KeyCode::Char(c) if key.modifiers.contains(KeyModifiers::ALT) => {
                Some(vec![0x1b, c as u8])
            }
            KeyCode::Char(c) if key.modifiers.contains(KeyModifiers::CONTROL) => {
                Some(vec![(c.to_ascii_lowercase() as u8) & 0x1f])
            }
            KeyCode::Char(c) => Some(c.to_string().into_bytes()),
            KeyCode::Enter => Some(vec![b'\r']),
            KeyCode::Backspace => Some(vec![0x7f]),
            KeyCode::Esc => Some(vec![0x1b]),
            KeyCode::Left => Some(b"\x1b[D".to_vec()),
            KeyCode::Right => Some(b"\x1b[C".to_vec()),
            KeyCode::Up => Some(b"\x1b[A".to_vec()),
            KeyCode::Down => Some(b"\x1b[B".to_vec()),
            KeyCode::Home => Some(b"\x1b[H".to_vec()),
            KeyCode::End => Some(b"\x1b[F".to_vec()),
            KeyCode::Delete => Some(b"\x1b[3~".to_vec()),
            KeyCode::PageUp => Some(b"\x1b[5~".to_vec()),
            KeyCode::PageDown => Some(b"\x1b[6~".to_vec()),
            _ => None,
        };
        if let Some(bytes) = bytes {
            self.write_focused(&bytes)?;
        }
        Ok(())
    }

    fn write_focused(&mut self, data: &[u8]) -> anyhow::Result<()> {
        let Some(tab) = self.tabs.get(self.focused) else {
            return Ok(());
        };
        if let Some(instance) = self.terminal_mgr.get(&tab.id) {
            instance.write(data)?;
        }
        Ok(())
    }

    fn resize_focused(&mut self) -> anyhow::Result<()> {
        let (cols, rows) = terminal::size().unwrap_or((80, 24));
        let sidebar = if self.tree_open {
            SIDEBAR_WIDTH.min(cols.saturating_sub(8))
        } else {
            0
        };
        if let Some(tab) = self.tabs.get(self.focused) {
            if let Some(instance) = self.terminal_mgr.get_mut(&tab.id) {
                instance.resize(
                    cols.saturating_sub(sidebar).max(2),
                    rows.saturating_sub(3).max(2),
                )?;
            }
        }
        Ok(())
    }

    fn reap_exited_tabs(&mut self) -> bool {
        let exited: Vec<usize> = self
            .tabs
            .iter()
            .enumerate()
            .filter_map(|(i, tab)| {
                self.terminal_mgr
                    .get(&tab.id)
                    .filter(|t| t.has_exited())
                    .map(|_| i)
            })
            .collect();
        if exited.is_empty() {
            return false;
        }
        for index in exited.into_iter().rev() {
            self.focused = index;
            self.close_focused();
        }
        true
    }

    fn sync_revisions(&mut self) -> bool {
        let mut changed = false;
        self.last_revisions
            .retain(|id, _| self.terminal_mgr.get(id).is_some());
        for tab in &self.tabs {
            if let Some(instance) = self.terminal_mgr.get(&tab.id) {
                let revision = instance.revision();
                if self.last_revisions.insert(tab.id.clone(), revision) != Some(revision) {
                    changed = true;
                }
            }
        }
        changed
    }

    fn expire_status(&mut self) -> bool {
        if self
            .status
            .as_ref()
            .is_some_and(|(_, at)| at.elapsed() > Duration::from_secs(3))
        {
            self.status = None;
            true
        } else {
            false
        }
    }
    fn set_status(&mut self, message: impl Into<String>) {
        self.status = Some((message.into(), Instant::now()));
    }

    fn render(&mut self, frame: &mut Frame) {
        let area = frame.area();
        let rows = Layout::vertical([
            Constraint::Length(1),
            Constraint::Min(1),
            Constraint::Length(1),
        ])
        .split(area);
        self.render_tabs(frame, rows[0]);
        let content = if self.tree_open {
            let split = Layout::horizontal([
                Constraint::Length(SIDEBAR_WIDTH.min(rows[1].width.saturating_sub(8))),
                Constraint::Min(1),
            ])
            .split(rows[1]);
            self.tree
                .render(frame, split[0], &self.theme, self.tree_focused);
            split[1]
        } else {
            rows[1]
        };
        if let Some(tab) = self.tabs.get(self.focused) {
            let instance = self.terminal_mgr.get(&tab.id);
            render::render_pane(
                frame,
                content,
                tab,
                !self.tree_focused,
                instance,
                &self.theme,
            );
        } else {
            frame.render_widget(
                Paragraph::new(
                    "No terminal tabs\n\nCtrl+N  new terminal    Ctrl+E  file tree    Ctrl+Q  quit",
                )
                .alignment(Alignment::Center)
                .style(Style::default().fg(self.theme.text)),
                content,
            );
        }
        let hint = if self.tree_focused {
            " tree: ↑↓ navigate · Enter expand · a file · d folder · m rename · Esc back "
        } else {
            " ^N new · ^W close · ^R rename · Tab/^←→ cycle · ^E tree · ^Q quit "
        };
        let message = self
            .status
            .as_ref()
            .map(|(m, _)| m.as_str())
            .unwrap_or(hint);
        frame.render_widget(
            Paragraph::new(message).style(Style::default().fg(self.theme.text_muted)),
            rows[2],
        );
        match self.overlay {
            Overlay::Rename => self.rename.render(frame, area, &self.theme),
            Overlay::Quit => self.render_quit(frame, area),
            Overlay::None => {}
        }
    }

    fn render_tabs(&self, frame: &mut Frame, area: Rect) {
        let mut spans = vec![Span::styled(
            " FluidState ",
            Style::default()
                .fg(Color::White)
                .bg(Color::Black)
                .add_modifier(Modifier::BOLD),
        )];
        for (index, tab) in self.tabs.iter().enumerate() {
            let style = if index == self.focused {
                Style::default()
                    .fg(Color::Black)
                    .bg(self.theme.text)
                    .add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(self.theme.text_muted)
            };
            spans.push(Span::styled(format!(" {} ", tab.name), style));
        }
        frame.render_widget(Paragraph::new(Line::from(spans)), area);
    }

    fn render_quit(&self, frame: &mut Frame, area: Rect) {
        let rect = Rect::new(
            area.x + area.width.saturating_sub(38) / 2,
            area.y + area.height.saturating_sub(5) / 2,
            38.min(area.width),
            5.min(area.height),
        );
        frame.render_widget(Clear, rect);
        frame.render_widget(
            Paragraph::new("Quit FluidState?\n\nCtrl+Q/y confirm · Esc/n cancel")
                .alignment(Alignment::Center)
                .block(Block::default().borders(Borders::ALL).title(" Quit ")),
            rect,
        );
    }
}

fn is_ctrl(key: KeyEvent, character: char) -> bool {
    key.modifiers.contains(KeyModifiers::CONTROL)
        && matches!(key.code, KeyCode::Char(c) if c.eq_ignore_ascii_case(&character))
}
fn is_ctrl_arrow(key: KeyEvent) -> bool {
    key.modifiers.contains(KeyModifiers::CONTROL)
        && matches!(key.code, KeyCode::Right | KeyCode::Down)
}
