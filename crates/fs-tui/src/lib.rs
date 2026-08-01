//! fs-tui — ratatui TUI application for FluidState.
//!
//! Provides the main App struct, event loop, grid layout computation,
//! terminal pane rendering, status bar, command palette, file viewer,
//! and diff view.

mod app;
mod file_tree;
mod render;
pub mod theme;

pub use app::App;
