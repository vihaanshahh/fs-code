//! fs-tui — ratatui TUI application for FluidState.
//!
//! Provides the main App struct, event loop, grid layout computation,
//! terminal pane rendering, status bar, command palette, file viewer,
//! and diff view.

mod app;
mod diff;
mod editor;
mod file_picker;
mod grid;
mod palette;
mod render;

pub use app::App;
