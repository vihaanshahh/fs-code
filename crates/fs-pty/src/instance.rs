//! A single terminal instance: PTY process + alacritty_terminal emulator.

use std::io::Read;
use std::sync::{Arc, Mutex};

use alacritty_terminal::event::{Event as AlacEvent, EventListener};
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::term::{Config as TermConfig, TermMode};
use alacritty_terminal::vte::ansi;
use alacritty_terminal::Term;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};

// ---------------------------------------------------------------------------
// EventProxy — required by Term, forwards events (bell, title, etc.)
// ---------------------------------------------------------------------------

#[derive(Clone)]
pub struct EventProxy;

impl EventListener for EventProxy {
    fn send_event(&self, _event: AlacEvent) {
        // MVP: events like bell, title change are ignored.
        // A full implementation would forward these via a channel.
    }
}

// ---------------------------------------------------------------------------
// SizeInfo wrapper — implements alacritty_terminal::grid::Dimensions
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy)]
struct Size {
    cols: usize,
    rows: usize,
}

impl Dimensions for Size {
    fn total_lines(&self) -> usize {
        self.rows
    }
    fn screen_lines(&self) -> usize {
        self.rows
    }
    fn columns(&self) -> usize {
        self.cols
    }
}

// ---------------------------------------------------------------------------
// TerminalInstance
// ---------------------------------------------------------------------------

pub struct TerminalInstance {
    /// The alacritty terminal emulator — holds the grid, colors, cursor state.
    /// Shared between the PTY reader thread (writes via process()) and the
    /// TUI renderer (reads via renderable_content()).
    pub term: Arc<Mutex<Term<EventProxy>>>,

    /// PTY master writer — used to send keyboard input to the child process.
    writer: Arc<Mutex<Box<dyn std::io::Write + Send>>>,

    /// PTY master handle — used for resize.
    master: Box<dyn MasterPty + Send>,

    /// Current dimensions.
    pub cols: u16,
    pub rows: u16,

    /// Set to true when the PTY reader thread detects EOF.
    pub exited: Arc<std::sync::atomic::AtomicBool>,

    /// Monotonic counter bumped whenever the PTY reader applies new output.
    revision: Arc<std::sync::atomic::AtomicU64>,
}

impl TerminalInstance {
    /// Spawn a new PTY process and create the terminal emulator.
    pub fn spawn(
        program: &str,
        args: &[String],
        cwd: &str,
        env: std::collections::HashMap<String, String>,
        cols: u16,
        rows: u16,
    ) -> anyhow::Result<Self>
    where
        Self: Sized,
    {
        let pty_system = native_pty_system();
        let pair = pty_system.openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;

        let mut cmd = CommandBuilder::new(program);
        for arg in args {
            cmd.arg(arg);
        }
        cmd.cwd(cwd);
        cmd.env_clear();
        for (k, v) in &env {
            cmd.env(k, v);
        }

        let mut child = pair.slave.spawn_command(cmd)?;

        let writer = pair.master.take_writer()?;
        let writer_arc = Arc::new(Mutex::new(writer));

        // Create alacritty terminal emulator
        let size = Size {
            cols: cols as usize,
            rows: rows as usize,
        };
        let config = TermConfig::default();
        let term = Term::new(config, &size, EventProxy);
        let term_arc = Arc::new(Mutex::new(term));

        let exited = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let revision = Arc::new(std::sync::atomic::AtomicU64::new(0));

        // Background thread: read PTY output → feed into Term
        let mut reader = pair.master.try_clone_reader()?;
        let term_for_reader = Arc::clone(&term_arc);
        let exited_flag = Arc::clone(&exited);
        let revision_flag = Arc::clone(&revision);

        std::thread::Builder::new()
            .name("pty-reader".into())
            .spawn(move || {
                let mut buf = [0u8; 4096];
                let mut parser: ansi::Processor = ansi::Processor::new();
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            if let Ok(mut t) = term_for_reader.lock() {
                                // Feed raw bytes through the VTE parser into the
                                // terminal emulator. This interprets all ANSI/VT
                                // escape sequences and updates the internal grid.
                                for byte in &buf[..n] {
                                    parser.advance(&mut *t, *byte);
                                }
                                revision_flag.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                            }
                        }
                        Err(_) => break,
                    }
                }
                // Reap child process
                match child.try_wait() {
                    Ok(Some(_)) => {}
                    _ => {
                        child.kill().ok();
                        child.wait().ok();
                    }
                }
                exited_flag.store(true, std::sync::atomic::Ordering::Relaxed);
            })?;

        Ok(Self {
            term: term_arc,
            writer: writer_arc,
            master: pair.master,
            cols,
            rows,
            exited,
            revision,
        })
    }

    /// Write input data (keyboard bytes) to the PTY.
    pub fn write(&self, data: &[u8]) -> anyhow::Result<()> {
        let mut w = self.writer.lock().map_err(|e| anyhow::anyhow!("{e}"))?;
        use std::io::Write;
        w.write_all(data)?;
        w.flush()?;
        Ok(())
    }

    /// Resize the terminal.
    pub fn resize(&mut self, cols: u16, rows: u16) -> anyhow::Result<()> {
        self.cols = cols;
        self.rows = rows;
        self.master.resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        if let Ok(mut t) = self.term.lock() {
            let size = Size {
                cols: cols as usize,
                rows: rows as usize,
            };
            t.resize(size);
        }
        Ok(())
    }

    /// Check if the PTY process has exited.
    pub fn has_exited(&self) -> bool {
        self.exited.load(std::sync::atomic::Ordering::Relaxed)
    }

    /// Revision of the terminal contents, incremented on PTY output.
    pub fn revision(&self) -> u64 {
        self.revision.load(std::sync::atomic::Ordering::Relaxed)
    }

    /// True if the underlying terminal is currently using the alternate screen
    /// buffer (full-screen TUIs like vim, less, copilot CLI). In this mode
    /// alacritty does not push lines into scrollback history, so our local
    /// scroll mechanism is a no-op — scroll input must be forwarded to the PTY.
    pub fn is_alt_screen(&self) -> bool {
        match self.term.lock() {
            Ok(t) => t.mode().contains(TermMode::ALT_SCREEN),
            Err(_) => false,
        }
    }

    /// True if the running app has enabled any form of mouse event reporting
    /// (DECSET 1000/1002/1003, with or without SGR extension). When this is
    /// on, alt-screen TUIs typically handle wheel events themselves — e.g.
    /// Ink-based CLIs (GitHub Copilot, Gemini) scroll their own chat log in
    /// response to SGR wheel escapes, whereas plain arrow keys just navigate
    /// the prompt history.
    pub fn mouse_reporting_enabled(&self) -> bool {
        match self.term.lock() {
            Ok(t) => t.mode().intersects(
                TermMode::MOUSE_REPORT_CLICK | TermMode::MOUSE_DRAG | TermMode::MOUSE_MOTION,
            ),
            Err(_) => false,
        }
    }

    /// Extract visible text from the terminal screen buffer.
    /// Returns the current viewport as a newline-separated string, stripping
    /// trailing whitespace from each row.
    pub fn visible_text(&self) -> String {
        let Ok(t) = self.term.lock() else {
            return String::new();
        };
        let grid = t.grid();
        let rows = grid.screen_lines();
        let cols = grid.columns();
        let mut lines = Vec::with_capacity(rows);
        for row_idx in 0..rows {
            let row = &grid[alacritty_terminal::index::Line(row_idx as i32)];
            let mut line = String::with_capacity(cols);
            for col_idx in 0..cols {
                let cell = &row[alacritty_terminal::index::Column(col_idx)];
                let c = cell.c;
                line.push(if c == '\0' { ' ' } else { c });
            }
            lines.push(line.trim_end().to_string());
        }
        // Remove trailing empty lines
        while lines.last().map_or(false, |l| l.is_empty()) {
            lines.pop();
        }
        lines.join("\n")
    }
}
