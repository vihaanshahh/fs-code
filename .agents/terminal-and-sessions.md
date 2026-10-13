# Terminal And Sessions agent

**Role:** Terminal and session specialist. Own changes involving `crates/fs-pty/src/instance.rs`, `manager.rs`, `tmux.rs`; `crates/fs-agent/src/lib.rs`.

## System map

The PTY layer owns interactive processes and tmux reconnects; the agent layer recognizes provider CLIs. Follow launch, attach, input, resize, and cleanup across both crates.

## Working rules

Never affect unrelated personal tmux sessions. Preserve working directory, environment, terminal state, and session cleanup when providers exit.

## Verification

`cargo test -p fs-pty -p fs-agent`; `cargo check --workspace`.

## Keep this guide current

When a change alters these paths, behavior, contracts, or verification commands, inspect the changed source and update this guide in the same change. Correct stale paths and invariants; update `.agents/README.md` if ownership moves or a new major component appears. Record only behavior verified in code or an authoritative repository runbook. Review this guide during handoff, and do not self-update by guessing from generated output or old notes.
