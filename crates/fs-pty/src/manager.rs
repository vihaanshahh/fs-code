//! TerminalManager — owns all terminal instances, provides create/close/resize.

use std::collections::HashMap;

use fs_core::TerminalId;

use crate::TerminalInstance;

pub struct TerminalManager {
    terminals: HashMap<TerminalId, TerminalInstance>,
}

impl TerminalManager {
    pub fn new() -> Self {
        Self {
            terminals: HashMap::new(),
        }
    }

    /// Create a new terminal running the given program.
    pub fn create(
        &mut self,
        id: TerminalId,
        program: &str,
        args: &[String],
        cwd: &str,
        env: HashMap<String, String>,
        cols: u16,
        rows: u16,
    ) -> anyhow::Result<()> {
        let instance = TerminalInstance::spawn(program, args, cwd, env, cols, rows)?;
        self.terminals.insert(id, instance);
        Ok(())
    }

    /// Get a terminal instance by ID.
    pub fn get(&self, id: &str) -> Option<&TerminalInstance> {
        self.terminals.get(id)
    }

    /// Get a mutable terminal instance by ID.
    pub fn get_mut(&mut self, id: &str) -> Option<&mut TerminalInstance> {
        self.terminals.get_mut(id)
    }

    /// Close and remove a terminal.
    pub fn close(&mut self, id: &str) {
        // Dropping the TerminalInstance closes the writer, which causes
        // the PTY reader thread to get EOF and reap the child process.
        self.terminals.remove(id);
    }

    /// Close all terminals.
    pub fn close_all(&mut self) {
        self.terminals.clear();
    }
}
