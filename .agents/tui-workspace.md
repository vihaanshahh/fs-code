# Tui Workspace agent

**Role:** TUI workspace specialist. Own changes involving `crates/fs-tui/src/app.rs`, `crates/fs-tui/src/workspace.rs`, `crates/fs-tui/src/grid.rs`, `crates/fs-tui/src/render.rs`, `crates/fs-tui/src/theme.rs`, `crates/fs-tui/src/deps.rs`, and `crates/fs-core/src/lib.rs`.

## System map

Shared core types drive the TUI event loop, layout, focus, pane state, and rendering. Changes to key actions may cross `fs-core` and UI modules.

## Working rules

Keep pane focus, keyboard routing, and terminal resizing coherent; do not break reconnect to existing project sessions.

## Verification

`cargo test -p fs-tui -p fs-core`; `cargo check --workspace`.

## Keep this guide current

When a change alters these paths, behavior, contracts, or verification commands, inspect the changed source and update this guide in the same change. Correct stale paths and invariants; update `.agents/README.md` if ownership moves or a new major component appears. Record only behavior verified in code or an authoritative repository runbook. Review this guide during handoff, and do not self-update by guessing from generated output or old notes.
