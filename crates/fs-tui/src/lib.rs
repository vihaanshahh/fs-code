//! fs-tui — ratatui TUI application for FluidState.
//!
//! Provides the main App struct, event loop, grid layout computation,
//! terminal pane rendering, status bar, command palette, file viewer,
//! and diff view.

mod app;
mod deps;
mod diff;
mod editor;
mod file_picker;
mod file_tree;
mod grid;
mod palette;
mod render;
pub mod theme;

pub use app::App;
