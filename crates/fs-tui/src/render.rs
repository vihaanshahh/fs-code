//! Rendering — draws terminal panes, welcome screen, and status bar.

use ratatui::prelude::*;
use ratatui::widgets::{Block, BorderType, Borders, Paragraph};

use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::term::cell::Flags as CellFlags;
use alacritty_terminal::vte::ansi::{Color as AnsiColor, NamedColor};

use fs_core::AgentDescriptor;
use fs_pty::TerminalInstance;

use crate::theme::Theme;

// ---------------------------------------------------------------------------
// Welcome screen (no agents)
// ---------------------------------------------------------------------------

pub fn render_welcome(frame: &mut Frame, area: Rect, theme: &Theme) {
    let text = vec![
        Line::from(""),
        Line::from(Span::styled(
            "FluidState",
            Style::default().fg(theme.text).add_modifier(Modifier::BOLD),
        )),
        Line::from(Span::styled(
            "Multi-agent IDE",
            Style::default().fg(theme.text_muted),
        )),
        Line::from(""),
        Line::from(Span::styled(
            "Ctrl+N  new agent    Ctrl+T  new in folder    Ctrl+Q  quit",
            Style::default().fg(theme.text),
        )),
        Line::from(Span::styled(
            "Ctrl+O  open file    Ctrl+D  diff file      Ctrl+F  focus editor",
            Style::default().fg(theme.text_muted),
        )),
        Line::from(Span::styled(
            "Ctrl+E  file tree    Ctrl+K  palette        Tab     focus editor",
            Style::default().fg(theme.text_muted),
        )),
    ];

    let paragraph = Paragraph::new(text).alignment(Alignment::Center);
    let v_pad = area.height.saturating_sub(7) / 2;
    let inner = Rect::new(area.x, area.y + v_pad, area.width, 7.min(area.height));
    frame.render_widget(paragraph, inner);
}

// ---------------------------------------------------------------------------
// Agent pane — header + terminal content
// ---------------------------------------------------------------------------

pub fn render_pane(
    frame: &mut Frame,
    area: Rect,
    agent: &AgentDescriptor,
    is_focused: bool,
    instance: Option<&TerminalInstance>,
    scroll_offset: usize,
    theme: &Theme,
) {
    if area.height < 2 || area.width < 4 { return; }

    let provider_tag = match agent.provider {
        fs_core::Provider::Claude => "",
        fs_core::Provider::Codex => " [Codex]",
    };
    let folder = std::path::Path::new(&agent.cwd)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| agent.cwd.clone());
    let title = if scroll_offset > 0 {
        format!(" ● {}{} — {} [↑{} lines — Shift+↓ to live] ", agent.name, provider_tag, folder, scroll_offset)
    } else if is_focused {
        format!(" ● {}{} — {} ", agent.name, provider_tag, folder)
    } else {
        format!("   {}{} — {} ", agent.name, provider_tag, folder)
    };

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
            .title_alignment(Alignment::Left)
    } else {
        Block::default()
            .borders(Borders::ALL)
            .border_type(BorderType::Plain)
            .border_style(Style::default().fg(theme.border))
            .title(Span::styled(
                title,
                Style::default().fg(theme.text_muted),
            ))
            .title_alignment(Alignment::Left)
    };

    let inner = block.inner(area);
    frame.render_widget(block, area);

    if let Some(inst) = instance {
        render_terminal_content(frame, inner, inst, scroll_offset);
    }
}

// ---------------------------------------------------------------------------
// Terminal content — map alacritty_terminal cells to ratatui spans
// ---------------------------------------------------------------------------

fn render_terminal_content(frame: &mut Frame, area: Rect, instance: &TerminalInstance, scroll_offset: usize) {
    let term = match instance.term.lock() {
        Ok(t) => t,
        Err(_) => return,
    };

    let content = term.renderable_content();
    let cursor = content.cursor;

    let cols = term.columns();
    let rows = term.screen_lines();
    let display_rows = (area.height as usize).min(rows);
    let display_cols = (area.width as usize).min(cols);

    for row in 0..display_rows {
        let y = area.y + row as u16;
        for col in 0..display_cols {
            let x = area.x + col as u16;

            let line_idx = row as i32 - scroll_offset as i32;
            let cell = &term.grid()[alacritty_terminal::index::Line(line_idx)][alacritty_terminal::index::Column(col)];
            let c = cell.c;

            let fg = map_color(cell.fg, Color::Reset);
            let bg = map_color(cell.bg, Color::Reset);

            let mut style = Style::default().fg(fg).bg(bg);

            if cell.flags.contains(CellFlags::BOLD) {
                style = style.add_modifier(Modifier::BOLD);
            }
            if cell.flags.contains(CellFlags::ITALIC) {
                style = style.add_modifier(Modifier::ITALIC);
            }
            if cell.flags.contains(CellFlags::UNDERLINE) || cell.flags.contains(CellFlags::ALL_UNDERLINES) {
                style = style.add_modifier(Modifier::UNDERLINED);
            }
            if cell.flags.contains(CellFlags::INVERSE) {
                style = Style::default().fg(bg).bg(fg);
            }

            if scroll_offset == 0 && row == cursor.point.line.0 as usize && col == cursor.point.column.0 {
                style = style.bg(Color::Black).fg(Color::White);
            }

            let ch = if c == '\0' || c == ' ' { ' ' } else { c };
            frame.buffer_mut().set_string(x, y, &ch.to_string(), style);
        }
    }
}

// ---------------------------------------------------------------------------
// Color mapping: alacritty_terminal → ratatui
// ---------------------------------------------------------------------------

fn map_color(color: AnsiColor, default: Color) -> Color {
    match color {
        AnsiColor::Named(named) => match named {
            NamedColor::Black         => Color::Black,
            NamedColor::Red           => Color::Red,
            NamedColor::Green         => Color::Green,
            NamedColor::Yellow        => Color::Yellow,
            NamedColor::Blue          => Color::Blue,
            NamedColor::Magenta       => Color::Magenta,
            NamedColor::Cyan          => Color::Cyan,
            NamedColor::White         => Color::White,
            NamedColor::BrightBlack   => Color::DarkGray,
            NamedColor::BrightRed     => Color::LightRed,
            NamedColor::BrightGreen   => Color::LightGreen,
            NamedColor::BrightYellow  => Color::LightYellow,
            NamedColor::BrightBlue    => Color::LightBlue,
            NamedColor::BrightMagenta => Color::LightMagenta,
            NamedColor::BrightCyan    => Color::LightCyan,
            NamedColor::BrightWhite   => Color::White,
            NamedColor::Foreground    => default,
            NamedColor::Background    => Color::Reset,
            _                         => default,
        },
        AnsiColor::Spec(rgb)    => Color::Rgb(rgb.r, rgb.g, rgb.b),
        AnsiColor::Indexed(idx) => Color::Indexed(idx),
    }
}

// ---------------------------------------------------------------------------
// Menu bar — persistent top row with all commands
// ---------------------------------------------------------------------------

pub fn render_menu_bar(frame: &mut Frame, area: Rect, theme: &Theme) {
    let items: &[(&str, &str)] = &[
        ("^N", "New"),
        ("^⇧N", "New…"),
        ("^W", "Close"),
        ("^O", "Open"),
        ("^F", "Focus Ed"),
        ("^D", "Diff"),
        ("^E", "Tree"),
        ("^I", "Deps"),
        ("^K", "Palette"),
        ("^S", "Save"),
        ("^G", "AI Edit"),
        ("^Q", "Quit"),
    ];

    let mut spans = Vec::new();
    for (key, label) in items {
        spans.push(Span::styled(
            format!(" {} ", key),
            Style::default().fg(Color::Black).bg(theme.text_muted),
        ));
        spans.push(Span::styled(
            format!("{} ", label),
            Style::default().fg(theme.text),
        ));
    }

    // Pad remainder
    let used: usize = spans.iter().map(|s| s.content.len()).sum();
    let remaining = (area.width as usize).saturating_sub(used);
    spans.push(Span::styled(" ".repeat(remaining), Style::default()));

    frame.render_widget(
        Paragraph::new(Line::from(spans)).style(Style::default().bg(Color::Reset)),
        area,
    );
}

// ---------------------------------------------------------------------------
// Status bar
// ---------------------------------------------------------------------------

pub fn render_status_bar(
    frame: &mut Frame,
    area: Rect,
    agents: &[AgentDescriptor],
    focused: usize,
    status_msg: Option<&str>,
    hint: &str,
    theme: &Theme,
) {
    let mut spans = vec![
        Span::styled(
            " FluidState ",
            Style::default().fg(Color::White).bg(Color::Black).add_modifier(Modifier::BOLD),
        ),
        Span::styled(" ", Style::default()),
    ];

    if agents.is_empty() {
        spans.push(Span::styled(
            "No agents — Ctrl+N to start",
            Style::default().fg(theme.text_muted),
        ));
    } else {
        for (i, agent) in agents.iter().enumerate() {
            let ptag = match agent.provider {
                fs_core::Provider::Codex => " ᶜˣ",
                _ => "",
            };
            if i == focused {
                spans.push(Span::styled(
                    format!(" ● {}{} ", agent.name, ptag),
                    Style::default().fg(Color::White).bg(Color::Black).add_modifier(Modifier::BOLD),
                ));
            } else {
                spans.push(Span::styled(
                    format!("  {}{} ", agent.name, ptag),
                    Style::default().fg(theme.text_muted),
                ));
            }
            spans.push(Span::styled(" ", Style::default()));
        }
    }

    if let Some(msg) = status_msg {
        spans.push(Span::styled(
            format!(" │ {} ", msg),
            Style::default().fg(theme.text),
        ));
    }

    let left_len: usize = spans.iter().map(|s| s.content.len()).sum();
    let right_len = hint.len();
    let padding = (area.width as usize).saturating_sub(left_len + right_len);
    spans.push(Span::styled(" ".repeat(padding), Style::default()));
    spans.push(Span::styled(
        hint.to_string(),
        Style::default().fg(theme.text_muted),
    ));

    frame.render_widget(Paragraph::new(Line::from(spans)), area);
}
