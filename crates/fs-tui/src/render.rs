//! Rendering — draws terminal panes, welcome screen, and status bar.
//!
//! Terminal pane rendering uses alacritty_terminal's renderable_content()
//! to get cells with characters, colors, and flags, then maps them to
//! ratatui Span/Style objects.

use ratatui::prelude::*;
use ratatui::widgets::{Block, Borders, Paragraph};

use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::term::cell::Flags as CellFlags;
use alacritty_terminal::vte::ansi::{Color as AnsiColor, NamedColor};

use fs_core::AgentDescriptor;
use fs_pty::TerminalInstance;

// ---------------------------------------------------------------------------
// Welcome screen (no agents)
// ---------------------------------------------------------------------------

pub fn render_welcome(frame: &mut Frame, area: Rect) {
    let text = vec![
        Line::from(""),
        Line::from(Span::styled(
            "FluidState",
            Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD),
        )),
        Line::from(Span::styled(
            "Multi-agent IDE",
            Style::default().fg(Color::DarkGray),
        )),
        Line::from(""),
        Line::from(Span::styled(
            "Ctrl+N  new agent    Ctrl+W  close    Ctrl+Q  quit",
            Style::default().fg(Color::DarkGray),
        )),
        Line::from(Span::styled(
            "Ctrl+K  palette      Tab     cycle    Ctrl+1-9 focus",
            Style::default().fg(Color::DarkGray),
        )),
    ];

    let paragraph = Paragraph::new(text).alignment(Alignment::Center);

    // Center vertically
    let v_pad = area.height.saturating_sub(6) / 2;
    let inner = Rect::new(area.x, area.y + v_pad, area.width, 6.min(area.height));
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
) {
    if area.height < 2 || area.width < 4 {
        return; // too small to render
    }

    let border_color = if is_focused { Color::Cyan } else { Color::DarkGray };
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(border_color))
        .title(Span::styled(
            format!(" {} ", agent.name),
            Style::default()
                .fg(if is_focused { Color::Cyan } else { Color::White })
                .add_modifier(Modifier::BOLD),
        ))
        .title_alignment(Alignment::Left);

    let inner = block.inner(area);
    frame.render_widget(block, area);

    // Render terminal content
    if let Some(inst) = instance {
        render_terminal_content(frame, inner, inst);
    }
}

// ---------------------------------------------------------------------------
// Terminal content — map alacritty_terminal cells to ratatui spans
// ---------------------------------------------------------------------------

fn render_terminal_content(frame: &mut Frame, area: Rect, instance: &TerminalInstance) {
    let term = match instance.term.lock() {
        Ok(t) => t,
        Err(_) => return,
    };

    let content = term.renderable_content();
    let cursor = content.cursor;

    // Build lines from renderable cells
    let cols = term.columns();
    let rows = term.screen_lines();
    let display_rows = (area.height as usize).min(rows);
    let display_cols = (area.width as usize).min(cols);

    for row in 0..display_rows {
        let y = area.y + row as u16;
        for col in 0..display_cols {
            let x = area.x + col as u16;

            let cell = &term.grid()[alacritty_terminal::index::Line(row as i32)][alacritty_terminal::index::Column(col)];
            let c = cell.c;

            let fg = map_color(cell.fg, Color::White);
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

            // Show cursor
            if row == cursor.point.line.0 as usize && col == cursor.point.column.0 {
                style = style.bg(Color::White).fg(Color::Black);
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
            NamedColor::Black => Color::Black,
            NamedColor::Red => Color::Red,
            NamedColor::Green => Color::Green,
            NamedColor::Yellow => Color::Yellow,
            NamedColor::Blue => Color::Blue,
            NamedColor::Magenta => Color::Magenta,
            NamedColor::Cyan => Color::Cyan,
            NamedColor::White => Color::White,
            NamedColor::BrightBlack => Color::DarkGray,
            NamedColor::BrightRed => Color::LightRed,
            NamedColor::BrightGreen => Color::LightGreen,
            NamedColor::BrightYellow => Color::LightYellow,
            NamedColor::BrightBlue => Color::LightBlue,
            NamedColor::BrightMagenta => Color::LightMagenta,
            NamedColor::BrightCyan => Color::LightCyan,
            NamedColor::BrightWhite => Color::White,
            _ => default,
        },
        AnsiColor::Spec(rgb) => Color::Rgb(rgb.r, rgb.g, rgb.b),
        AnsiColor::Indexed(idx) => Color::Indexed(idx),
    }
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
) {
    let mut spans = vec![
        Span::styled(" FluidState ", Style::default().fg(Color::Black).bg(Color::Cyan).add_modifier(Modifier::BOLD)),
        Span::raw(" "),
    ];

    if agents.is_empty() {
        spans.push(Span::styled("No agents — Ctrl+N to start", Style::default().fg(Color::DarkGray)));
    } else {
        for (i, agent) in agents.iter().enumerate() {
            let style = if i == focused {
                Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(Color::DarkGray)
            };
            spans.push(Span::styled(format!(" [{}] {} ", i + 1, agent.name), style));
        }
    }

    // Status message (if any)
    if let Some(msg) = status_msg {
        spans.push(Span::styled(
            format!(" │ {} ", msg),
            Style::default().fg(Color::Yellow),
        ));
    }

    // Right-align shortcuts hint
    let hint = " ^O open │ ^D diff │ ^R replace │ ^K palette ";
    let left_len: usize = spans.iter().map(|s| s.content.len()).sum();
    let padding = (area.width as usize).saturating_sub(left_len + hint.len());
    spans.push(Span::raw(" ".repeat(padding)));
    spans.push(Span::styled(hint, Style::default().fg(Color::DarkGray)));

    let line = Line::from(spans);
    let bar = Paragraph::new(line).style(Style::default().bg(Color::Rgb(20, 20, 30)));
    frame.render_widget(bar, area);
}
