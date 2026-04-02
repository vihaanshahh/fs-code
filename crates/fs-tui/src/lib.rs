//! fs-tui — ratatui TUI application for FluidState.
//!
//! Provides the main App struct, event loop, grid layout computation,
//! terminal pane rendering, status bar, and command palette.

mod app;
mod grid;
mod render;
mod palette;

pub use app::App;
