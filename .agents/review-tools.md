# Review Tools agent

**Role:** Review tools specialist. Own changes involving `crates/fs-tui/src/diff.rs`, `editor.rs`, `file_picker.rs`, `file_tree.rs`, `palette.rs`, `clipboard.rs`.

## System map

These overlays expose files, diffs, edits, and commands inside the TUI; route actions back through shared app state.

## Working rules

Keep filesystem operations scoped to the current project and preserve unsaved edits and keyboard escape behavior.

## Verification

`cargo test -p fs-tui`; manually exercise changed overlay in `cargo run -p fluidstate` if interactive behavior changed.

## Keep this guide current

When a change alters these paths, behavior, contracts, or verification commands, inspect the changed source and update this guide in the same change. Correct stale paths and invariants; add a cross-link in `README.md` if ownership moves or a new major component appears. Record only behavior verified in code or an authoritative repository runbook. Review this guide during handoff, and do not self-update by guessing from generated output or old notes.
