//! Color theme for FluidState TUI — plain black and white terminal defaults.

use ratatui::style::Color;

// ---------------------------------------------------------------------------
// Theme mode (single theme)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub enum ThemeMode {
    #[default]
    Clay,
}

impl ThemeMode {
    pub fn label(self) -> &'static str {
        "Default"
    }

    pub fn next(self) -> Self {
        self
    }
}

// ---------------------------------------------------------------------------
// Theme struct
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct Theme {
    pub mode: ThemeMode,
    // Backgrounds
    pub bg: Color,
    pub bg_surface: Color,
    // Text
    pub text: Color,
    pub text_secondary: Color,
    pub text_muted: Color,
    // Structure
    pub border: Color,
    pub accent: Color,
    // Semantic
    pub green: Color,
    pub red: Color,
    pub blue: Color,
    pub amber: Color,
    pub purple: Color,
    pub pink: Color,
    // Diff backgrounds
    pub diff_add_bg: Color,
    pub diff_remove_bg: Color,
}

const fn rgb(r: u8, g: u8, b: u8) -> Color {
    Color::Rgb(r, g, b)
}

// ---------------------------------------------------------------------------
// Theme definition — plain terminal defaults
// ---------------------------------------------------------------------------

pub fn theme(_mode: ThemeMode) -> Theme {
    Theme {
        mode: ThemeMode::Clay,
        // transparent — use whatever the terminal background is
        bg:             Color::Reset,
        bg_surface:     Color::Reset,
        // black text hierarchy
        text:           Color::Black,
        text_secondary: Color::Black,
        text_muted:     Color::DarkGray,
        // borders
        border:         Color::DarkGray,
        // accent for focus highlights (inverted: white-on-black)
        accent:         Color::Black,
        // semantic colors — standard terminal palette
        green:          Color::Green,
        red:            Color::Red,
        blue:           Color::Blue,
        amber:          Color::Yellow,
        purple:         Color::Magenta,
        pink:           Color::Magenta,
        // diff backgrounds — keep subtle color for readability
        diff_add_bg:    rgb(0xd4, 0xec, 0xd0),
        diff_remove_bg: rgb(0xec, 0xd0, 0xcc),
    }
}
