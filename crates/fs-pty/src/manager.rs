//! TerminalManager — owns all terminal instances, provides create/close/resize.

use std::collections::HashMap;

use fs_core::TerminalId;

use crate::TerminalInstance;

pub struct TerminalManager {
    terminals: HashMap<TerminalId, TerminalInstance>,
}

impl Default for TerminalManager {
    fn default() -> Self { Self::new() }
}

impl TerminalManager {
    pub fn new() -> Self {
        Self {
            terminals: HashMap::new(),
        }
    }

    /// Create a new terminal running the given program.
    #[allow(clippy::too_many_arguments)] // Mirrors TerminalInstance::spawn's PTY contract.
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
        if let Some(mut previous) = self.terminals.insert(id, instance) {
            previous.shutdown();
        }
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
        if let Some(mut terminal) = self.terminals.remove(id) {
            terminal.shutdown();
        }
    }

    /// Close all terminals.
    pub fn close_all(&mut self) {
        for (_, mut terminal) in self.terminals.drain() {
            terminal.shutdown();
        }
    }
}
