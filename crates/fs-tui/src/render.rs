//! Rendering for the focused terminal tab.

use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::term::cell::Flags as CellFlags;
use alacritty_terminal::vte::ansi::{Color as AnsiColor, NamedColor};
use fs_core::AgentDescriptor;
use fs_pty::TerminalInstance;
use ratatui::prelude::*;
use ratatui::widgets::{Block, BorderType, Borders, Paragraph};

use crate::theme::Theme;

pub fn render_pane(
    frame: &mut Frame,
    area: Rect,
    tab: &AgentDescriptor,
    is_focused: bool,
    instance: Option<&TerminalInstance>,
    theme: &Theme,
) {
    if area.height < 2 || area.width < 4 {
        return;
    }

    let folder = std::path::Path::new(&tab.cwd)
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| tab.cwd.clone());
    let title = if is_focused {
        format!(" ● {} — {} ", tab.name, folder)
    } else {
        format!("   {} — {} ", tab.name, folder)
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
    } else {
        Block::default()
            .borders(Borders::ALL)
            .border_type(BorderType::Plain)
            .border_style(Style::default().fg(theme.border))
            .title(Span::styled(title, Style::default().fg(theme.text_muted)))
    };
    let inner = block.inner(area);
    frame.render_widget(block, area);
    if let Some(instance) = instance {
        render_terminal_content(frame, inner, instance);
    }
}

fn render_terminal_content(frame: &mut Frame, area: Rect, instance: &TerminalInstance) {
    let term = match instance.term.try_lock() {
        Ok(term) => term,
        Err(std::sync::TryLockError::WouldBlock) => {
            frame.render_widget(
                Paragraph::new("updating...")
                    .style(Style::default().fg(Color::DarkGray))
                    .alignment(Alignment::Center),
                area,
            );
            return;
        }
        Err(std::sync::TryLockError::Poisoned(_)) => return,
    };

    let cursor = term.renderable_content().cursor;
    let rows = (area.height as usize).min(term.screen_lines());
    let cols = (area.width as usize).min(term.columns());
    for row in 0..rows {
        for col in 0..cols {
            let cell = &term.grid()[alacritty_terminal::index::Line(row as i32)]
                [alacritty_terminal::index::Column(col)];
            let mut style = Style::default()
                .fg(map_color(cell.fg, Color::Reset))
                .bg(map_color(cell.bg, Color::Reset));
            if cell.flags.contains(CellFlags::BOLD) {
                style = style.add_modifier(Modifier::BOLD);
            }
            if cell.flags.contains(CellFlags::ITALIC) {
                style = style.add_modifier(Modifier::ITALIC);
            }
            if cell.flags.contains(CellFlags::UNDERLINE)
                || cell.flags.contains(CellFlags::ALL_UNDERLINES)
            {
                style = style.add_modifier(Modifier::UNDERLINED);
            }
            if cell.flags.contains(CellFlags::INVERSE) {
                style = Style::default()
                    .fg(map_color(cell.bg, Color::Reset))
                    .bg(map_color(cell.fg, Color::Reset));
            }
            if row == cursor.point.line.0 as usize && col == cursor.point.column.0 {
                style = style.bg(Color::Black).fg(Color::White);
            }
            let character = if cell.c == '\0' || cell.c == ' ' {
                ' '
            } else {
                cell.c
            };
            frame.buffer_mut().set_string(
                area.x + col as u16,
                area.y + row as u16,
                character.to_string(),
                style,
            );
        }
    }
}

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
            NamedColor::Foreground => default,
            NamedColor::Background => Color::Reset,
            _ => default,
        },
        AnsiColor::Spec(rgb) => Color::Rgb(rgb.r, rgb.g, rgb.b),
        AnsiColor::Indexed(index) => Color::Indexed(index),
    }
}
