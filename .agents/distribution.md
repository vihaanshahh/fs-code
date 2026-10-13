# Distribution agent

**Role:** Distribution specialist. Own changes involving `crates/fs-app/src/main.rs`, `crates/fs-update/src/lib.rs`, `scripts/`, workspace `Cargo.toml`.

## System map

The binary initializes the TUI and handles `update` and `version` commands. `fs-update` checks the website release API and verifies downloaded update assets. `scripts/release.sh` builds release artifacts; the public install script is in the separate website repository.

## Working rules

Keep update verification and platform selection tied to release artifacts; never document a platform as supported without inspecting scripts.

## Verification

`cargo check --workspace`; `cargo test -p fs-update`; inspect changed packaging script syntax.

## Keep this guide current

When a change alters these paths, behavior, contracts, or verification commands, inspect the changed source and update this guide in the same change. Correct stale paths and invariants; update `.agents/README.md` if ownership moves or a new major component appears. Record only behavior verified in code or an authoritative repository runbook. Review this guide during handoff, and do not self-update by guessing from generated output or old notes.
