//! Minimal inline file editor — view and edit files within a pane.
//!
//! Features:
//!   - Syntax-aware line numbers with color
//!   - Cursor navigation (arrows, Home/End, PgUp/PgDn)
//!   - Basic editing (insert, delete, backspace, enter)
//!   - Undo / redo
//!   - Mouse cursor placement and selection
//!   - Search and go-to-line prompts
//!   - Scrolling with viewport tracking
//!   - Block (rectangular) selection
//!   - Code folding (indentation-based)
//!   - Inline diagnostics
//!   - Symbol outline navigation
//!   - Multi-tab file management
//!   - Inline find/replace bar

use std::collections::{hash_map::DefaultHasher, HashSet};
use std::hash::{Hash, Hasher};

use ratatui::prelude::*;
use ratatui::widgets::{Block, Borders, Clear, Scrollbar, ScrollbarOrientation, ScrollbarState};

use crate::highlight::{self, Lang};
use crate::theme::Theme;

// ---------------------------------------------------------------------------
// Inline find/replace bar field focus
// ---------------------------------------------------------------------------

/// Which field is focused in the inline find/replace bar.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReplaceField {
    Find,
    Replace,
}

// ---------------------------------------------------------------------------
// Block (rectangular / column) selection
// ---------------------------------------------------------------------------

/// A rectangular selection defined by two corner positions.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BlockSelection {
    pub anchor: (usize, usize),
    pub cursor: (usize, usize),
}

#[allow(dead_code)]
impl BlockSelection {
    pub fn new(anchor: (usize, usize), cursor: (usize, usize)) -> Self {
        Self { anchor, cursor }
    }

    pub fn top_left(&self) -> (usize, usize) {
        (self.anchor.0.min(self.cursor.0), self.anchor.1.min(self.cursor.1))
    }

    pub fn bottom_right(&self) -> (usize, usize) {
        (self.anchor.0.max(self.cursor.0), self.anchor.1.max(self.cursor.1))
    }

    pub fn contains(&self, line: usize, col: usize) -> bool {
        let (tl, br) = (self.top_left(), self.bottom_right());
        line >= tl.0 && line <= br.0 && col >= tl.1 && col < br.1
    }

    pub fn line_range(&self) -> (usize, usize) {
        (self.anchor.0.min(self.cursor.0), self.anchor.0.max(self.cursor.0))
    }

    pub fn col_range(&self) -> (usize, usize) {
        (self.anchor.1.min(self.cursor.1), self.anchor.1.max(self.cursor.1))
    }
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

#[allow(dead_code)]
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum DiagnosticSeverity {
    Hint,
    Info,
    Warning,
    Error,
}

#[allow(dead_code)]
#[derive(Clone, Debug)]
pub struct Diagnostic {
    pub line: usize,
    pub col_start: usize,
    pub col_end: usize,
    pub severity: DiagnosticSeverity,
    pub message: String,
}

// ---------------------------------------------------------------------------
// Symbol types for outline navigation
// ---------------------------------------------------------------------------

#[derive(Clone, Debug)]
pub struct Symbol {
    pub name: String,
    #[allow(dead_code)]
    pub kind: SymbolKind,
    pub line: usize,
}

#[derive(Clone, Debug, PartialEq)]
pub enum SymbolKind {
    Function,
    Struct,
    Class,
    Enum,
    Interface,
    Constant,
    Trait,
    Module,
    Type,
    Impl,
}

impl SymbolKind {
    #[allow(dead_code)]
    pub fn label(&self) -> &'static str {
        match self {
            SymbolKind::Function => "fn",
            SymbolKind::Struct => "struct",
            SymbolKind::Class => "class",
            SymbolKind::Enum => "enum",
            SymbolKind::Interface => "interface",
            SymbolKind::Trait => "trait",
            SymbolKind::Constant => "const",
            SymbolKind::Module => "mod",
            SymbolKind::Type => "type",
            SymbolKind::Impl => "impl",
        }
    }
}

// ---------------------------------------------------------------------------
// Prompt and editor types
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PromptMode {
    Ai,
    Search,
    GotoLine,
}

#[allow(dead_code)]
pub enum PromptSubmit {
    Ai {
        instruction: String,
        path: String,
    },
    Search {
        query: String,
    },
    Replace {
        query: String,
        replacement: String,
        replaced: usize,
    },
    GotoLine {
        line: usize,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OpenFileOutcome {
    Opened,
    Reloaded,
    PreservedDirty,
    PreservedDirtyWithDiskChanges,
}

#[derive(Clone)]
struct Snapshot {
    lines: Vec<String>,
    cursor: (usize, usize),
    scroll: usize,
    scroll_x: usize,
    selection: Option<Selection>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Selection {
    anchor: (usize, usize),
    cursor: (usize, usize),
}

impl Selection {
    fn normalized(self) -> ((usize, usize), (usize, usize)) {
        if self.anchor <= self.cursor {
            (self.anchor, self.cursor)
        } else {
            (self.cursor, self.anchor)
        }
    }
}

/// Public selection primitive for batched editor operations.
#[allow(dead_code)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SelectionRange {
    pub anchor: (usize, usize),
    pub cursor: (usize, usize),
}

#[allow(dead_code)]
impl SelectionRange {
    pub fn new(anchor: (usize, usize), cursor: (usize, usize)) -> Self {
        Self { anchor, cursor }
    }

    pub fn collapsed(pos: (usize, usize)) -> Self {
        Self {
            anchor: pos,
            cursor: pos,
        }
    }

    pub fn normalized(self) -> ((usize, usize), (usize, usize)) {
        if self.anchor <= self.cursor {
            (self.anchor, self.cursor)
        } else {
            (self.cursor, self.anchor)
        }
    }

    pub fn is_collapsed(self) -> bool {
        self.anchor == self.cursor
    }
}

/// Ordered set of selection ranges for batch editing.
#[allow(dead_code)]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SelectionSet {
    ranges: Vec<SelectionRange>,
}

#[allow(dead_code)]
impl SelectionSet {
    pub fn new() -> Self {
        Self { ranges: Vec::new() }
    }

    pub fn from_ranges(ranges: Vec<SelectionRange>) -> Self {
        Self { ranges }
    }

    pub fn push(&mut self, range: SelectionRange) {
        self.ranges.push(range);
    }

    pub fn is_empty(&self) -> bool {
        self.ranges.is_empty()
    }

    pub fn len(&self) -> usize {
        self.ranges.len()
    }

    pub fn ranges(&self) -> &[SelectionRange] {
        &self.ranges
    }

    pub fn normalized_ranges(&self) -> Vec<SelectionRange> {
        let mut ranges: Vec<SelectionRange> = self
            .ranges
            .iter()
            .copied()
            .filter(|r| !r.is_collapsed())
            .collect();
        ranges.sort_by_key(|r| r.normalized().0);

        let mut merged: Vec<SelectionRange> = Vec::new();
        for range in ranges {
            let (start, end) = range.normalized();
            if let Some(last) = merged.last_mut() {
                let (last_start, last_end) = last.normalized();
                if start <= last_end {
                    let new_end = if end > last_end { end } else { last_end };
                    *last = SelectionRange::new(last_start, new_end);
                    continue;
                }
            }
            merged.push(SelectionRange::new(start, end));
        }
        merged
    }
}

const MAX_UNDO_STACK: usize = 100;

#[derive(Clone, Copy, PartialEq)]
enum EditKind {
    Insert,
    Delete,
}

#[derive(Clone, Copy)]
pub struct SearchMatch {
    pub line: usize,
    pub start: usize,
    pub end: usize,
}

pub struct Editor {
    pub path: String,
    lines: Vec<String>,
    pub cursor: (usize, usize),
    pub scroll: usize,
    pub dirty: bool,
    open: bool,
    viewport_height: usize,
    viewport_width: usize,
    pub scroll_x: usize,
    preferred_col: Option<usize>,
    lang: Lang,
    prompt_mode: Option<PromptMode>,
    pub prompt_input: String,
    pub ai_working: bool,
    pub ai_status: Option<String>,
    pub wrap: bool,
    selection: Option<Selection>,
    extra_cursors: Vec<(usize, usize)>,
    undo_stack: Vec<Snapshot>,
    redo_stack: Vec<Snapshot>,
    last_edit_kind: Option<EditKind>,
    search_query: Option<String>,
    replace_query: Option<String>,
    replace_with: Option<String>,
    search_matches: Vec<SearchMatch>,
    active_match: usize,
    last_inner: Option<Rect>,
    last_gutter_w: u16,
    // -- Inline find/replace bar --
    pub replace_open: bool,
    pub replace_field_focus: ReplaceField,
    pub replace_find_buf: String,
    pub replace_replace_buf: String,
    // -- Block (rectangular) selection --
    pub block_selection: Option<BlockSelection>,
    // -- Code folding --
    folded: HashSet<usize>,
    fold_hidden: Vec<(usize, usize)>, // cached sorted (start_exclusive, end_inclusive) ranges
    disk_hash: Option<u64>,
    // -- Diagnostics --
    diagnostics: Vec<Diagnostic>,
    pub show_diagnostics: bool,
    pub diagnostic_cursor: Option<usize>,
    // -- Symbol outline --
    pub outline_open: bool,
    outline_symbols: Vec<Symbol>,
    outline_filter: String,
    outline_selected: usize,
    // -- Tab management --
    tabs: Vec<EditorTab>,
    pub active_tab: usize,
}

/// Per-tab state snapshot for multi-tab support.
/// Each tab remembers its file path, lines, cursor, scroll, and dirty flag.
#[allow(dead_code)]
struct EditorTab {
    path: String,
    lines: Vec<String>,
    cursor: (usize, usize),
    scroll: usize,
    scroll_x: usize,
    dirty: bool,
    lang: Lang,
    undo_stack: Vec<Snapshot>,
    redo_stack: Vec<Snapshot>,
    last_edit_kind: Option<EditKind>,
    search_query: Option<String>,
    search_matches: Vec<SearchMatch>,
    active_match: usize,
    selection: Option<Selection>,
    extra_cursors: Vec<(usize, usize)>,
    folded: HashSet<usize>,
    diagnostics: Vec<Diagnostic>,
    disk_hash: Option<u64>,
}

#[allow(dead_code)]
impl Editor {
    pub fn new() -> Self {
        Self {
            path: String::new(),
            lines: vec![String::new()],
            cursor: (0, 0),
            scroll: 0,
            dirty: false,
            open: false,
            viewport_height: 20,
            viewport_width: 80,
            scroll_x: 0,
            preferred_col: None,
            lang: Lang::Generic,
            prompt_mode: None,
            prompt_input: String::new(),
            ai_working: false,
            ai_status: None,
            wrap: false,
            selection: None,
            extra_cursors: Vec::new(),
            undo_stack: Vec::new(),
            redo_stack: Vec::new(),
            last_edit_kind: None,
            search_query: None,
            replace_query: None,
            replace_with: None,
            search_matches: Vec::new(),
            active_match: 0,
            last_inner: None,
            last_gutter_w: 0,
            // Inline find/replace
            replace_open: false,
            replace_field_focus: ReplaceField::Find,
            replace_find_buf: String::new(),
            replace_replace_buf: String::new(),
            // Block selection
            block_selection: None,
            // Code folding
            folded: HashSet::new(),
            fold_hidden: Vec::new(),
            disk_hash: None,
            // Diagnostics
            diagnostics: Vec::new(),
            show_diagnostics: true,
            diagnostic_cursor: None,
            // Symbol outline
            outline_open: false,
            outline_symbols: Vec::new(),
            outline_filter: String::new(),
            outline_selected: 0,
            // Tab management
            tabs: Vec::new(),
            active_tab: 0,
            // Reusable render buffers
        }
    }

    /// Ensure critical invariants: lines is non-empty and cursor is in bounds.
    fn ensure_invariants(&mut self) {
        if self.lines.is_empty() {
            self.lines.push(String::new());
        }
        self.cursor.0 = self.cursor.0.min(self.lines.len() - 1);
        self.cursor.1 = self.cursor.1.min(self.lines[self.cursor.0].len());
    }

    pub fn is_open(&self) -> bool {
        self.open
    }

    pub fn is_prompt_open(&self) -> bool {
        self.prompt_mode.is_some()
    }

    pub fn has_selection(&self) -> bool {
        self.selection
            .map(|s| s.anchor != s.cursor)
            .unwrap_or(false)
    }

    pub fn has_extra_cursors(&self) -> bool {
        !self.extra_cursors.is_empty()
    }

    pub fn toggle_wrap(&mut self) -> bool {
        self.wrap = !self.wrap;
        if self.wrap {
            self.scroll_x = 0;
        }
        self.ensure_visible();
        self.wrap
    }

    pub fn open_file(&mut self, path: &str) -> Result<OpenFileOutcome, String> {
        // Tab deduplication: if this file is already open in a tab, switch to it
        if let Some(idx) = self.tabs.iter().position(|t| t.path == path) {
            self.save_current_tab();
            self.active_tab = idx;
            self.restore_active_tab();
            // Explicitly opening a clean cached tab should reflect disk changes.
            if !self.dirty {
                self.reload()?;
                self.open = true;
                return Ok(OpenFileOutcome::Reloaded);
            }
            let outcome = if self.disk_changed_since_load() {
                OpenFileOutcome::PreservedDirtyWithDiskChanges
            } else {
                OpenFileOutcome::PreservedDirty
            };
            self.open = true;
            return Ok(outcome);
        }

        let content = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
        let disk_hash = Self::content_hash(&content);

        // Save current state to tab before switching
        if self.open && !self.path.is_empty() {
            self.save_current_tab();
        }

        self.path = path.to_string();
        self.lang = Lang::from_path(path);
        self.lines = content.lines().map(|l| l.to_string()).collect();
        if self.lines.is_empty() {
            self.lines.push(String::new());
        }
        self.cursor = (0, 0);
        self.scroll = 0;
        self.scroll_x = 0;
        self.preferred_col = None;
        self.dirty = false;
        self.open = true;
        self.selection = None;
        self.extra_cursors.clear();
        self.undo_stack.clear();
        self.redo_stack.clear();
        self.prompt_mode = None;
        self.prompt_input.clear();
        self.search_query = None;
        self.replace_query = None;
        self.replace_with = None;
        self.search_matches.clear();
        self.active_match = 0;
        self.block_selection = None;
        self.folded.clear();
        self.fold_hidden.clear();
        self.disk_hash = Some(disk_hash);
        self.diagnostics.clear();
        self.diagnostic_cursor = None;
        self.replace_open = false;
        self.outline_open = false;

        // Add/update tab
        self.save_current_tab();
        // save_current_tab moves the live buffer into the tab slot; restore it
        // so the newly opened file is visible immediately.
        self.restore_active_tab();
        Ok(OpenFileOutcome::Opened)
    }

    pub fn close(&mut self) {
        self.open = false;
        self.prompt_mode = None;
        self.selection = None;
        self.extra_cursors.clear();
        self.block_selection = None;
        self.outline_open = false;
        self.replace_open = false;
    }

    /// Number of lines in the buffer.
    pub fn line_count(&self) -> usize {
        self.lines.len()
    }

    /// Read-only access to lines (for copying, etc.)
    pub fn lines_ref(&self) -> &[String] {
        &self.lines
    }

    // -----------------------------------------------------------------------
    // Tab management
    // -----------------------------------------------------------------------

    /// Save the current editor state into the tabs list.
    ///
    /// Large heap data (lines, undo/redo stacks, search matches, extra
    /// cursors, folded set, diagnostics) is **moved** out of the editor via
    /// `std::mem::take`, avoiding expensive deep clones on every tab switch.
    /// After this call the editor's Vec/HashSet fields are empty; callers
    /// must either restore a tab or assign fresh data before using the editor.
    fn save_current_tab(&mut self) {
        if self.path.is_empty() {
            return;
        }
        let tab = EditorTab {
            path: self.path.clone(),
            lines: std::mem::take(&mut self.lines),
            cursor: self.cursor,
            scroll: self.scroll,
            scroll_x: self.scroll_x,
            dirty: self.dirty,
            lang: self.lang,
            undo_stack: std::mem::take(&mut self.undo_stack),
            redo_stack: std::mem::take(&mut self.redo_stack),
            last_edit_kind: self.last_edit_kind.take(),
            search_query: self.search_query.take(),
            search_matches: std::mem::take(&mut self.search_matches),
            active_match: self.active_match,
            selection: self.selection,
            extra_cursors: std::mem::take(&mut self.extra_cursors),
            folded: std::mem::take(&mut self.folded),
            diagnostics: std::mem::take(&mut self.diagnostics),
            disk_hash: self.disk_hash,
        };
        // Safety: ensure lines is never empty after take
        if self.lines.is_empty() {
            self.lines.push(String::new());
        }
        if let Some(idx) = self.tabs.iter().position(|t| t.path == self.path) {
            self.tabs[idx] = tab;
            self.active_tab = idx;
        } else {
            self.tabs.push(tab);
            self.active_tab = self.tabs.len() - 1;
        }
    }

    /// Restore the active tab's state into the editor fields.
    ///
    /// Large heap data is **swapped** out of the tab slot into the editor via
    /// `std::mem::swap` -- O(1) pointer swaps, zero allocations.  The tab
    /// slot keeps its `path` (small clone) so `tab_info()` can still read it;
    /// its Vec/HashSet fields become empty after the swap.
    fn restore_active_tab(&mut self) {
        if self.active_tab >= self.tabs.len() {
            return;
        }
        let tab = &mut self.tabs[self.active_tab];
        self.path = tab.path.clone();
        std::mem::swap(&mut self.lines, &mut tab.lines);
        self.cursor = tab.cursor;
        self.scroll = tab.scroll;
        self.scroll_x = tab.scroll_x;
        self.dirty = tab.dirty;
        self.lang = tab.lang;
        std::mem::swap(&mut self.undo_stack, &mut tab.undo_stack);
        std::mem::swap(&mut self.redo_stack, &mut tab.redo_stack);
        self.search_query = tab.search_query.take();
        std::mem::swap(&mut self.search_matches, &mut tab.search_matches);
        self.active_match = tab.active_match;
        self.selection = tab.selection;
        std::mem::swap(&mut self.extra_cursors, &mut tab.extra_cursors);
        std::mem::swap(&mut self.folded, &mut tab.folded);
        std::mem::swap(&mut self.diagnostics, &mut tab.diagnostics);
        self.disk_hash = tab.disk_hash;
        // Safety: lines must never be empty
        if self.lines.is_empty() {
            self.lines.push(String::new());
        }
        self.cursor.0 = self.cursor.0.min(self.lines.len().saturating_sub(1));
        self.block_selection = None;
        self.prompt_mode = None;
        self.prompt_input.clear();
        self.replace_open = false;
        self.outline_open = false;
        self.rebuild_fold_cache();
    }

    fn content_hash(content: &str) -> u64 {
        let mut hasher = DefaultHasher::new();
        content.hash(&mut hasher);
        hasher.finish()
    }

    fn disk_changed_since_load(&self) -> bool {
        let Some(disk_hash) = self.disk_hash else {
            return false;
        };
        std::fs::read_to_string(&self.path)
            .map(|content| Self::content_hash(&content) != disk_hash)
            .unwrap_or(false)
    }

    /// Number of open tabs.
    pub fn tab_count(&self) -> usize {
        self.tabs.len()
    }

    /// Switch to the next tab.
    pub fn next_tab(&mut self) {
        if self.tabs.len() > 1 {
            self.save_current_tab();
            self.active_tab = (self.active_tab + 1) % self.tabs.len();
            self.restore_active_tab();
        }
    }

    /// Switch to the previous tab.
    pub fn prev_tab(&mut self) {
        if self.tabs.len() > 1 {
            self.save_current_tab();
            self.active_tab = (self.active_tab + self.tabs.len() - 1) % self.tabs.len();
            self.restore_active_tab();
        }
    }

    /// Switch to a specific tab by index.
    #[allow(dead_code)]
    pub fn switch_tab(&mut self, idx: usize) {
        if idx < self.tabs.len() && idx != self.active_tab {
            self.save_current_tab();
            self.active_tab = idx;
            self.restore_active_tab();
        }
    }

    /// Close the active tab. Returns true if the editor should close entirely.
    #[allow(dead_code)]
    pub fn close_tab(&mut self) -> bool {
        if self.tabs.is_empty() {
            self.open = false;
            return true;
        }
        self.tabs.remove(self.active_tab);
        if self.tabs.is_empty() {
            self.open = false;
            return true;
        }
        if self.active_tab >= self.tabs.len() {
            self.active_tab = self.tabs.len() - 1;
        }
        self.restore_active_tab();
        false
    }

    // -----------------------------------------------------------------------
    // Inline find/replace bar
    // -----------------------------------------------------------------------

    pub fn open_replace_bar(&mut self) {
        self.replace_open = true;
        self.replace_field_focus = ReplaceField::Find;
        self.replace_find_buf = self
            .search_query
            .clone()
            .or_else(|| self.current_find_seed())
            .unwrap_or_default();
        self.replace_replace_buf = self.replace_with.clone().unwrap_or_default();
        self.update_replace_matches();
    }

    pub fn close_replace_bar(&mut self) {
        self.replace_open = false;
    }

    pub fn replace_toggle_field(&mut self) {
        self.replace_field_focus = match self.replace_field_focus {
            ReplaceField::Find => ReplaceField::Replace,
            ReplaceField::Replace => ReplaceField::Find,
        };
    }

    pub fn replace_char(&mut self, c: char) {
        match self.replace_field_focus {
            ReplaceField::Find => {
                self.replace_find_buf.push(c);
                self.update_replace_matches();
            }
            ReplaceField::Replace => {
                self.replace_replace_buf.push(c);
            }
        }
    }

    pub fn replace_backspace(&mut self) {
        match self.replace_field_focus {
            ReplaceField::Find => {
                self.replace_find_buf.pop();
                self.update_replace_matches();
            }
            ReplaceField::Replace => {
                self.replace_replace_buf.pop();
            }
        }
    }

    fn update_replace_matches(&mut self) {
        if self.replace_find_buf.is_empty() {
            self.search_query = None;
            self.search_matches.clear();
            self.active_match = 0;
            return;
        }
        self.replace_query = Some(self.replace_find_buf.clone());
        self.replace_with = Some(self.replace_replace_buf.clone());
        self.set_search_query_near_cursor(self.replace_find_buf.clone());
    }

    pub fn replace_bar_next(&mut self) -> bool {
        self.next_search_match()
    }

    pub fn replace_bar_prev(&mut self) -> bool {
        self.prev_search_match()
    }

    pub fn replace_bar_current(&mut self) -> bool {
        self.replace_with = Some(self.replace_replace_buf.clone());
        self.replace_current_and_next()
    }

    pub fn replace_bar_all(&mut self) -> usize {
        self.replace_with = Some(self.replace_replace_buf.clone());
        let query = self.replace_find_buf.clone();
        let replacement = self.replace_replace_buf.clone();
        if query.is_empty() { return 0; }
        self.replace_all(&query, &replacement)
    }

    // -----------------------------------------------------------------------
    // Block (rectangular) selection
    // -----------------------------------------------------------------------

    pub fn extend_block_selection_dir(&mut self, dline: i32, dcol: i32) {
        let bs = self.block_selection.get_or_insert_with(|| {
            BlockSelection::new(self.cursor, self.cursor)
        });
        let new_line = if dline < 0 {
            bs.cursor.0.saturating_sub((-dline) as usize)
        } else {
            (bs.cursor.0 + dline as usize).min(self.lines.len().saturating_sub(1))
        };
        let new_col = if dcol < 0 {
            bs.cursor.1.saturating_sub((-dcol) as usize)
        } else {
            bs.cursor.1 + dcol as usize
        };
        bs.cursor = (new_line, new_col);
        self.cursor = bs.cursor;
        self.clamp_col();
        self.ensure_visible();
    }

    pub fn clear_block_selection(&mut self) {
        self.block_selection = None;
    }

    #[allow(dead_code)]
    pub fn block_selected_text(&self) -> Option<String> {
        let bs = self.block_selection.as_ref()?;
        let (min_line, max_line) = bs.line_range();
        let (min_col, max_col) = bs.col_range();
        if min_col >= max_col { return None; }
        let mut result = String::new();
        for line_idx in min_line..=max_line {
            if line_idx > min_line { result.push('\n'); }
            if line_idx < self.lines.len() {
                let chars: Vec<char> = self.lines[line_idx].chars().collect();
                for col in min_col..max_col {
                    result.push(if col < chars.len() { chars[col] } else { ' ' });
                }
            }
        }
        Some(result)
    }

    pub fn delete_block_selection(&mut self) {
        let Some(bs) = self.block_selection.take() else { return };
        let (min_line, max_line) = bs.line_range();
        let (min_col, max_col) = bs.col_range();
        if min_col >= max_col { return; }
        self.begin_edit();
        for line_idx in min_line..=max_line.min(self.lines.len().saturating_sub(1)) {
            let chars: Vec<char> = self.lines[line_idx].chars().collect();
            let cs = min_col.min(chars.len());
            let ce = max_col.min(chars.len());
            let new: String = chars[..cs].iter().chain(chars[ce..].iter()).collect();
            self.lines[line_idx] = new;
        }
        self.cursor = (min_line, min_col);
        self.finish_edit();
    }

    pub fn block_insert_char(&mut self, c: char) {
        let Some(bs) = self.block_selection.take() else { return };
        let (min_line, max_line) = bs.line_range();
        let col = bs.top_left().1;
        self.begin_edit();
        for line_idx in min_line..=max_line.min(self.lines.len().saturating_sub(1)) {
            let insert_at = col.min(self.lines[line_idx].len());
            self.lines[line_idx].insert(insert_at, c);
        }
        self.cursor = (min_line, col + 1);
        self.finish_edit();
    }

    pub fn block_backspace(&mut self) {
        let Some(bs) = self.block_selection.take() else { return };
        let (min_line, max_line) = bs.line_range();
        let col = bs.top_left().1;
        if col == 0 { return; }
        self.begin_edit();
        for line_idx in min_line..=max_line.min(self.lines.len().saturating_sub(1)) {
            let del_at = (col - 1).min(self.lines[line_idx].len().saturating_sub(1));
            if del_at < self.lines[line_idx].len() {
                self.lines[line_idx].remove(del_at);
            }
        }
        self.cursor = (min_line, col - 1);
        self.finish_edit();
    }

    // -----------------------------------------------------------------------
    // Multi-cursor skip/remove (Feature 3)
    // -----------------------------------------------------------------------

    /// Skip the current occurrence, move to next. Returns Some((n, total)) on success.
    pub fn skip_current_occurrence(&mut self) -> Option<(usize, usize)> {
        if self.extra_cursors.is_empty() {
            return None;
        }
        // Remove the last added extra cursor
        self.extra_cursors.pop();
        // Add next occurrence
        self.add_next_occurrence_cursor().then(|| {
            (self.extra_cursors.len() + 1, self.search_matches.len())
        })
    }

    /// Remove the last added extra cursor. Returns true if one was removed.
    pub fn remove_last_cursor(&mut self) -> bool {
        self.extra_cursors.pop().is_some()
    }

    /// Count of cursors including primary.
    pub fn occurrence_cursor_count(&self) -> usize {
        self.extra_cursors.len() + 1
    }

    // -----------------------------------------------------------------------
    // Code folding (indentation-based)
    // -----------------------------------------------------------------------

    fn indent_level(line: &str) -> usize {
        let mut level = 0;
        for ch in line.chars() {
            match ch {
                ' ' => level += 1,
                '\t' => level += 4,
                _ => break,
            }
        }
        level
    }

    pub fn fold_range(&self, line: usize) -> Option<(usize, usize)> {
        if line >= self.lines.len() { return None; }
        let start_indent = Self::indent_level(&self.lines[line]);
        let mut next_nb = line + 1;
        while next_nb < self.lines.len() && self.lines[next_nb].trim().is_empty() {
            next_nb += 1;
        }
        if next_nb >= self.lines.len() { return None; }
        if Self::indent_level(&self.lines[next_nb]) <= start_indent { return None; }
        let mut last_non_blank = next_nb;
        for i in (next_nb + 1)..self.lines.len() {
            if self.lines[i].trim().is_empty() { continue; }
            if Self::indent_level(&self.lines[i]) <= start_indent { break; }
            last_non_blank = i;
        }
        if last_non_blank <= line { return None; }
        Some((line, last_non_blank))
    }

    #[allow(dead_code)]    pub fn is_folded(&self, line: usize) -> bool {
        self.folded.contains(&line)
    }

    pub fn toggle_fold(&mut self, line: usize) {
        if self.folded.contains(&line) {
            self.folded.remove(&line);
        } else if self.fold_range(line).is_some() {
            self.folded.insert(line);
        }
        self.rebuild_fold_cache();
    }

    pub fn toggle_fold_at_cursor(&mut self) {
        self.toggle_fold(self.cursor.0);
    }

    pub fn fold_all(&mut self) {
        let mut i = 0;
        while i < self.lines.len() {
            if let Some((_start, end)) = self.fold_range(i) {
                self.folded.insert(i);
                i = end + 1;
            } else {
                i += 1;
            }
        }
        self.rebuild_fold_cache();
    }

    pub fn unfold_all(&mut self) {
        self.folded.clear();
        self.rebuild_fold_cache();
    }

    /// Rebuild the cached list of hidden line ranges from the current fold set.
    /// Called after any mutation to `self.folded`.
    fn rebuild_fold_cache(&mut self) {
        self.fold_hidden.clear();
        for &header in &self.folded {
            if let Some((start, end)) = self.fold_range(header) {
                self.fold_hidden.push((start, end));
            }
        }
        self.fold_hidden.sort_unstable();
    }

    pub fn is_line_visible(&self, line: usize) -> bool {
        // Ranges are sorted by start. Use binary search to find the last range
        // whose start < line, then check if line falls within it.
        let idx = self.fold_hidden.partition_point(|&(start, _end)| start < line);
        if idx > 0 {
            let (start, end) = self.fold_hidden[idx - 1];
            if line > start && line <= end {
                return false;
            }
        }
        true
    }

    #[allow(dead_code)]
    pub fn visible_line_count(&self) -> usize {
        let hidden: usize = self.fold_hidden.iter().map(|&(start, end)| end - start).sum();
        self.lines.len().saturating_sub(hidden)
    }

    // -----------------------------------------------------------------------
    // Diagnostics API
    // -----------------------------------------------------------------------

    pub fn set_diagnostics(&mut self, mut diags: Vec<Diagnostic>) {
    #[allow(dead_code)]        diags.sort_by(|a, b| a.line.cmp(&b.line).then(a.col_start.cmp(&b.col_start)));
        self.diagnostics = diags;
        self.diagnostic_cursor = None;
    }

    pub fn clear_diagnostics(&mut self) {
        self.diagnostics.clear();
        self.diagnostic_cursor = None;
    }

    pub fn next_diagnostic(&mut self) -> bool {
        if self.diagnostics.is_empty() { return false; }
        let next = match self.diagnostic_cursor {
            Some(idx) => if idx + 1 < self.diagnostics.len() { idx + 1 } else { 0 },
            None => self.diagnostics.iter().position(|d| d.line >= self.cursor.0).unwrap_or(0),
        };
        self.diagnostic_cursor = Some(next);
        let diag = &self.diagnostics[next];
        self.cursor.0 = diag.line.min(self.lines.len().saturating_sub(1));
        self.cursor.1 = diag.col_start;
        self.clamp_col();
        self.ensure_visible();
        true
    }

    pub fn prev_diagnostic(&mut self) -> bool {
        if self.diagnostics.is_empty() { return false; }
        let prev = match self.diagnostic_cursor {
            Some(idx) => if idx > 0 { idx - 1 } else { self.diagnostics.len() - 1 },
            None => self.diagnostics.iter().rposition(|d| d.line <= self.cursor.0)
                .unwrap_or(self.diagnostics.len() - 1),
        };
        self.diagnostic_cursor = Some(prev);
        let diag = &self.diagnostics[prev];
        self.cursor.0 = diag.line.min(self.lines.len().saturating_sub(1));
        self.cursor.1 = diag.col_start;
        self.clamp_col();
        self.ensure_visible();
        true
    }

    pub fn diagnostics_at_line(&self, line: usize) -> Vec<&Diagnostic> {
        self.diagnostics.iter().filter(|d| d.line == line).collect()
    }

    pub fn toggle_diagnostics(&mut self) {
        self.show_diagnostics = !self.show_diagnostics;
    }

    pub fn diagnostics(&self) -> &[Diagnostic] {
        &self.diagnostics
    }

    // -----------------------------------------------------------------------
    // Symbol extraction & outline navigation
    // -----------------------------------------------------------------------

    pub fn extract_symbols(&self) -> Vec<Symbol> {
        let mut symbols = Vec::new();
        for (line_idx, line) in self.lines.iter().enumerate() {
            let trimmed = line.trim_start();
            if let Some(sym) = self.match_symbol(trimmed, line_idx) {
                symbols.push(sym);
            }
        }
        symbols
    }

    fn match_symbol(&self, trimmed: &str, line: usize) -> Option<Symbol> {
        match self.lang {
            Lang::Rust => Self::match_rust_symbol(trimmed, line),
            Lang::Js => Self::match_js_symbol(trimmed, line),
            Lang::Python => Self::match_python_symbol(trimmed, line),
            Lang::Go => Self::match_go_symbol(trimmed, line),
            Lang::C => Self::match_c_symbol(trimmed, line),
            _ => Self::match_generic_symbol(trimmed, line),
        }
    }

    fn strip_rust_vis(s: &str) -> &str {
        if let Some(rest) = s.strip_prefix("pub(") {
            if let Some(close) = rest.find(") ") {
                return &rest[close + 2..];
            }
        }
        s.strip_prefix("pub ").unwrap_or(s)
    }

    fn extract_name(rest: &str) -> Option<String> {
        let name: String = rest.chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect();
        if name.is_empty() { None } else { Some(name) }
    }

    fn match_rust_symbol(trimmed: &str, line: usize) -> Option<Symbol> {
        let s = Self::strip_rust_vis(trimmed);
        let s = s.strip_prefix("async ").unwrap_or(s);
        let s = s.strip_prefix("unsafe ").unwrap_or(s);

        if let Some(rest) = s.strip_prefix("fn ") {
            return Some(Symbol { name: Self::extract_name(rest)?, kind: SymbolKind::Function, line });
        }
        if let Some(rest) = s.strip_prefix("struct ") {
            return Some(Symbol { name: Self::extract_name(rest)?, kind: SymbolKind::Struct, line });
        }
        if let Some(rest) = s.strip_prefix("enum ") {
            return Some(Symbol { name: Self::extract_name(rest)?, kind: SymbolKind::Enum, line });
        }
        if let Some(rest) = s.strip_prefix("trait ") {
            return Some(Symbol { name: Self::extract_name(rest)?, kind: SymbolKind::Trait, line });
        }
        if let Some(rest) = s.strip_prefix("impl ") {
            return Some(Symbol { name: Self::extract_name(rest)?, kind: SymbolKind::Impl, line });
        }
        if let Some(rest) = s.strip_prefix("mod ") {
            return Some(Symbol { name: Self::extract_name(rest)?, kind: SymbolKind::Module, line });
        }
        if let Some(rest) = s.strip_prefix("const ") {
            return Some(Symbol { name: Self::extract_name(rest)?, kind: SymbolKind::Constant, line });
        }
        if let Some(rest) = s.strip_prefix("type ") {
            return Some(Symbol { name: Self::extract_name(rest)?, kind: SymbolKind::Type, line });
        }
        None
    }

    fn match_js_symbol(trimmed: &str, line: usize) -> Option<Symbol> {
        let s = trimmed.strip_prefix("export ").unwrap_or(trimmed);
        let s = s.strip_prefix("default ").unwrap_or(s);
        let s = s.strip_prefix("declare ").unwrap_or(s);
        let s = s.strip_prefix("abstract ").unwrap_or(s);
        let s = s.strip_prefix("async ").unwrap_or(s);

        if let Some(rest) = s.strip_prefix("function ") {
            return Some(Symbol { name: Self::extract_name(rest)?, kind: SymbolKind::Function, line });
        }
        if let Some(rest) = s.strip_prefix("class ") {
            return Some(Symbol { name: Self::extract_name(rest)?, kind: SymbolKind::Class, line });
        }
        if let Some(rest) = s.strip_prefix("interface ") {
            return Some(Symbol { name: Self::extract_name(rest)?, kind: SymbolKind::Interface, line });
        }
        if let Some(rest) = s.strip_prefix("type ") {
            return Some(Symbol { name: Self::extract_name(rest)?, kind: SymbolKind::Type, line });
        }
        if let Some(rest) = s.strip_prefix("enum ") {
            return Some(Symbol { name: Self::extract_name(rest)?, kind: SymbolKind::Enum, line });
        }
        if let Some(rest) = s.strip_prefix("const ") {
            return Some(Symbol { name: Self::extract_name(rest)?, kind: SymbolKind::Constant, line });
        }
        None
    }

    fn match_python_symbol(trimmed: &str, line: usize) -> Option<Symbol> {
        let s = trimmed.strip_prefix("async ").unwrap_or(trimmed);
        if let Some(rest) = s.strip_prefix("def ") {
            return Some(Symbol { name: Self::extract_name(rest)?, kind: SymbolKind::Function, line });
        }
        if let Some(rest) = trimmed.strip_prefix("class ") {
            return Some(Symbol { name: Self::extract_name(rest)?, kind: SymbolKind::Class, line });
        }
        None
    }

    fn match_go_symbol(trimmed: &str, line: usize) -> Option<Symbol> {
        if let Some(rest) = trimmed.strip_prefix("func ") {
            let rest = if rest.starts_with('(') {
                if let Some(close) = rest.find(") ") { &rest[close + 2..] } else { rest }
            } else { rest };
            return Some(Symbol { name: Self::extract_name(rest)?, kind: SymbolKind::Function, line });
        }
        if let Some(rest) = trimmed.strip_prefix("type ") {
            return Some(Symbol { name: Self::extract_name(rest)?, kind: SymbolKind::Type, line });
        }
        None
    }

    fn match_c_symbol(trimmed: &str, line: usize) -> Option<Symbol> {
        if let Some(rest) = trimmed.strip_prefix("struct ") {
            return Some(Symbol { name: Self::extract_name(rest)?, kind: SymbolKind::Struct, line });
        }
        if let Some(rest) = trimmed.strip_prefix("enum ") {
            return Some(Symbol { name: Self::extract_name(rest)?, kind: SymbolKind::Enum, line });
        }
        if let Some(rest) = trimmed.strip_prefix("typedef ") {
            return Some(Symbol { name: Self::extract_name(rest)?, kind: SymbolKind::Type, line });
        }
        None
    }

    fn match_generic_symbol(trimmed: &str, line: usize) -> Option<Symbol> {
        Self::match_rust_symbol(trimmed, line)
            .or_else(|| Self::match_js_symbol(trimmed, line))
            .or_else(|| Self::match_python_symbol(trimmed, line))
    }

    pub fn open_outline(&mut self) {
        self.outline_symbols = self.extract_symbols();
        self.outline_filter.clear();
        self.outline_selected = 0;
        self.outline_open = true;
    }

    pub fn close_outline(&mut self) {
        self.outline_open = false;
        self.outline_filter.clear();
    }

    pub fn outline_char(&mut self, c: char) {
        self.outline_filter.push(c);
        self.outline_selected = 0;
    }

    pub fn outline_backspace(&mut self) {
        self.outline_filter.pop();
        self.outline_selected = 0;
    }

    pub fn outline_select(&mut self, idx: usize) {
        let count = self.filtered_outline().len();
        if idx < count {
            self.outline_selected = idx;
        }
    }

    pub fn outline_move(&mut self, delta: i32) {
        let filtered = self.filtered_outline();
        if filtered.is_empty() { return; }
        let new = self.outline_selected as i32 + delta;
        self.outline_selected = new.clamp(0, filtered.len() as i32 - 1) as usize;
    }

    pub fn outline_confirm(&mut self) -> bool {
        let filtered = self.filtered_outline();
        if let Some(sym) = filtered.get(self.outline_selected) {
            let line = sym.line;
            self.outline_open = false;
            self.outline_filter.clear();
            self.goto_line(line);
            true
        } else {
            false
        }
    }

    pub fn filtered_outline(&self) -> Vec<&Symbol> {
        let query = self.outline_filter.to_lowercase();
        self.outline_symbols
            .iter()
            .filter(|s| query.is_empty() || s.name.to_lowercase().contains(&query))
            .collect()
    }

    pub fn outline_filter_text(&self) -> &str {
        &self.outline_filter
    }

    pub fn outline_selected_idx(&self) -> usize {
        self.outline_selected
    }

    /// Render the outline popup overlay.
    pub fn render_outline(&self, frame: &mut Frame, area: Rect, theme: &Theme) {
        if !self.outline_open { return; }
        let w = 50u16.min(area.width.saturating_sub(4));
        let h = 20u16.min(area.height.saturating_sub(4));
        let x = area.x + (area.width.saturating_sub(w)) / 2;
        let y = area.y + (area.height.saturating_sub(h)) / 3;
        let popup = Rect::new(x, y, w, h);
        frame.render_widget(Clear, popup);

        let block = Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(theme.text))
            .title(Span::styled(
                " Go to Symbol (Ctrl+R) ",
                Style::default().fg(theme.text).add_modifier(Modifier::BOLD),
            ));
        let inner = block.inner(popup);
        frame.render_widget(block, popup);
        if inner.height < 3 { return; }

        let prompt = format!("❯ {}", self.outline_filter);
        frame.buffer_mut().set_string(inner.x, inner.y, &prompt, Style::default().fg(theme.text));

        let filtered = self.filtered_outline();
        let list_y = inner.y + 1;
        let list_h = (inner.height - 1) as usize;
        for (i, sym) in filtered.iter().enumerate().take(list_h) {
            let ry = list_y + i as u16;
            let is_sel = i == self.outline_selected;
            let style = if is_sel {
                Style::default().fg(Color::Black).bg(theme.text)
            } else {
                Style::default().fg(theme.text)
            };
            let kind_style = if is_sel {
                Style::default().fg(Color::DarkGray).bg(theme.text)
            } else {
                Style::default().fg(theme.text_muted)
            };
            let indicator = if is_sel { "▸ " } else { "  " };
            frame.buffer_mut().set_string(inner.x, ry, indicator, style);
            let kind_label = format!("{} ", sym.kind.label());
            frame.buffer_mut().set_string(inner.x + 2, ry, &kind_label, kind_style);
            let name_x = inner.x + 2 + kind_label.len() as u16;
            frame.buffer_mut().set_string(name_x, ry, &sym.name, style);
            let line_str = format!(":{}", sym.line + 1);
            let line_x = inner.x + inner.width.saturating_sub(line_str.len() as u16 + 1);
            frame.buffer_mut().set_string(line_x, ry, &line_str, kind_style);
        }
    }

    pub fn save(&mut self) -> Result<(), String> {
        let content = self.content();
        let disk_hash = Self::content_hash(&content);
        std::fs::write(&self.path, &content).map_err(|e| e.to_string())?;
        self.disk_hash = Some(disk_hash);
        self.dirty = false;
        Ok(())
    }

    pub fn content(&self) -> String {
        self.lines.join("\n") + "\n"
    }

    pub fn open_ai_prompt(&mut self) {
        if self.ai_working {
            return;
        }
        self.prompt_mode = Some(PromptMode::Ai);
        self.prompt_input.clear();
        self.ai_status = None;
    }

    pub fn open_search_prompt(&mut self) {
        self.prompt_mode = Some(PromptMode::Search);
        self.prompt_input = self
            .search_query
            .clone()
            .or_else(|| self.current_find_seed())
            .unwrap_or_default();
    }

    pub fn open_goto_line_prompt(&mut self) {
        self.prompt_mode = Some(PromptMode::GotoLine);
        self.prompt_input = (self.cursor.0 + 1).to_string();
    }

    pub fn close_prompt(&mut self) {
        self.prompt_mode = None;
        self.prompt_input.clear();
    }

    pub fn prompt_char(&mut self, c: char) {
        self.prompt_input.push(c);
        self.preview_prompt();
    }

    pub fn prompt_backspace(&mut self) {
        self.prompt_input.pop();
        self.preview_prompt();
    }

    pub fn submit_prompt(&mut self) -> Option<PromptSubmit> {
        let mode = self.prompt_mode?;
        match mode {
            PromptMode::Ai => {
                if self.prompt_input.trim().is_empty() {
                    return None;
                }
                let instruction = self.prompt_input.clone();
                let path = self.path.clone();
                self.prompt_mode = None;
                self.prompt_input.clear();
                self.ai_working = true;
                self.ai_status = Some("AI working...".into());
                Some(PromptSubmit::Ai { instruction, path })
            }
            PromptMode::Search => {
                let query = self.prompt_input.trim().to_string();
                self.prompt_mode = None;
                self.prompt_input.clear();
                self.set_search_query_near_cursor(query.clone());
                Some(PromptSubmit::Search { query })
            }
            PromptMode::GotoLine => {
                let line = self
                    .prompt_input
                    .trim()
                    .parse::<usize>()
                    .ok()?
                    .saturating_sub(1);
                self.prompt_mode = None;
                self.prompt_input.clear();
                self.goto_line(line);
                Some(PromptSubmit::GotoLine { line })
            }
        }
    }

    pub fn reload(&mut self) -> Result<(), String> {
        let content = std::fs::read_to_string(&self.path).map_err(|e| e.to_string())?;
        let disk_hash = Self::content_hash(&content);
        let old_cursor = self.cursor;
        self.lines = content.lines().map(|l| l.to_string()).collect();
        if self.lines.is_empty() {
            self.lines.push(String::new());
        }
        self.cursor.0 = old_cursor.0.min(self.lines.len().saturating_sub(1));
        self.clamp_col();
        self.preferred_col = None;
        self.selection = None;
        self.undo_stack.clear();
        self.redo_stack.clear();
        self.block_selection = None;
        self.folded.clear();
        self.fold_hidden.clear();
        self.diagnostics.clear();
        self.diagnostic_cursor = None;
        if let Some(query) = self.search_query.clone() {
            self.set_search_query(query);
        }
        self.ensure_visible();
        self.disk_hash = Some(disk_hash);
        self.dirty = false;
        Ok(())
    }

    pub fn move_up(&mut self) {
        self.clear_selection();
        if self.has_extra_cursors() {
            self.move_all_cursors_with(|editor, pos| {
                let line = pos.0.saturating_sub(1);
                let col = pos.1.min(editor.lines[line].chars().count());
                (line, col)
            });
            return;
        }
        if self.wrap && self.move_up_wrapped() {
            return;
        }
        if self.cursor.0 > 0 {
            let target_col = self.preferred_col.unwrap_or(self.cursor.1);
            self.cursor.0 -= 1;
            self.cursor.1 = target_col.min(self.current_line_len());
            self.preferred_col = Some(target_col);
            self.ensure_visible();
        }
    }

    pub fn move_down(&mut self) {
        self.clear_selection();
        if self.has_extra_cursors() {
            self.move_all_cursors_with(|editor, pos| {
                let line = (pos.0 + 1).min(editor.lines.len().saturating_sub(1));
                let col = pos.1.min(editor.lines[line].chars().count());
                (line, col)
            });
            return;
        }
        if self.wrap && self.move_down_wrapped() {
            return;
        }
        if self.cursor.0 < self.lines.len() - 1 {
            let target_col = self.preferred_col.unwrap_or(self.cursor.1);
            self.cursor.0 += 1;
            self.cursor.1 = target_col.min(self.current_line_len());
            self.preferred_col = Some(target_col);
            self.ensure_visible();
        }
    }

    pub fn move_left(&mut self) {
        self.clear_selection();
        if self.has_extra_cursors() {
            self.move_all_cursors_with(|editor, pos| {
                if pos.1 > 0 {
                    (pos.0, pos.1 - 1)
                } else if pos.0 > 0 {
                    let line = pos.0 - 1;
                    (line, editor.lines[line].chars().count())
                } else {
                    pos
                }
            });
            return;
        }
        if self.cursor.1 > 0 {
            self.cursor.1 -= 1;
            self.preferred_col = None;
            self.ensure_visible_h();
        } else if self.cursor.0 > 0 {
            self.cursor.0 -= 1;
            self.cursor.1 = self.current_line_len();
            self.preferred_col = None;
            self.ensure_visible();
        }
    }

    pub fn move_right(&mut self) {
        self.clear_selection();
        if self.has_extra_cursors() {
            self.move_all_cursors_with(|editor, pos| {
                let line_len = editor.lines[pos.0].chars().count();
                if pos.1 < line_len {
                    (pos.0, pos.1 + 1)
                } else if pos.0 < editor.lines.len().saturating_sub(1) {
                    (pos.0 + 1, 0)
                } else {
                    pos
                }
            });
            return;
        }
        let len = self.current_line_len();
        if self.cursor.1 < len {
            self.cursor.1 += 1;
            self.preferred_col = None;
            self.ensure_visible_h();
        } else if self.cursor.0 < self.lines.len() - 1 {
            self.cursor.0 += 1;
            self.cursor.1 = 0;
            self.preferred_col = None;
            self.ensure_visible();
        }
    }

    pub fn move_home(&mut self) {
        self.clear_selection();
        if self.has_extra_cursors() {
            self.move_all_cursors_with(|_, pos| (pos.0, 0));
            return;
        }
        self.cursor.1 = 0;
        self.preferred_col = None;
        self.ensure_visible_h();
    }

    pub fn move_end(&mut self) {
        self.clear_selection();
        if self.has_extra_cursors() {
            self.move_all_cursors_with(|editor, pos| (pos.0, editor.lines[pos.0].chars().count()));
            return;
        }
        self.cursor.1 = self.current_line_len();
        self.preferred_col = None;
        self.ensure_visible_h();
    }

    pub fn page_up(&mut self) {
        self.clear_selection();
        let jump = self.usable_viewport_height();
        if self.has_extra_cursors() {
            self.move_all_cursors_with(|editor, pos| {
                let line = pos.0.saturating_sub(jump);
                let col = pos.1.min(editor.lines[line].chars().count());
                (line, col)
            });
            return;
        }
        if self.wrap {
            for _ in 0..jump {
                if !self.move_up_wrapped() && self.cursor.0 == 0 {
                    break;
                }
            }
            return;
        }
        self.cursor.0 = self.cursor.0.saturating_sub(jump);
        self.clamp_col();
        self.preferred_col = Some(self.cursor.1);
        self.ensure_visible();
    }

    pub fn page_down(&mut self) {
        self.clear_selection();
        let jump = self.usable_viewport_height();
        if self.has_extra_cursors() {
            self.move_all_cursors_with(|editor, pos| {
                let line = (pos.0 + jump).min(editor.lines.len().saturating_sub(1));
                let col = pos.1.min(editor.lines[line].chars().count());
                (line, col)
            });
            return;
        }
        if self.wrap {
            for _ in 0..jump {
                if !self.move_down_wrapped() && self.cursor.0 == self.lines.len().saturating_sub(1)
                {
                    break;
                }
            }
            return;
        }
        self.cursor.0 = (self.cursor.0 + jump).min(self.lines.len() - 1);
        self.clamp_col();
        self.preferred_col = Some(self.cursor.1);
        self.ensure_visible();
    }

    #[allow(dead_code)]
    pub fn scroll_by(&mut self, delta: i32) {
        let visible = self.usable_viewport_height();
        let max_scroll = self.max_user_scroll();
        if delta < 0 {
            self.scroll = self.scroll.saturating_sub((-delta) as usize);
        } else {
            self.scroll = (self.scroll + delta as usize).min(max_scroll);
        }
        // Keep the cursor anchored to actual content — don't drag it into
        // the empty overscroll rows past the end of the file.
        let last_line = self.lines.len().saturating_sub(1);
        if self.cursor.0 < self.scroll {
            self.cursor.0 = self.scroll.min(last_line);
            self.clamp_col();
        } else if self.cursor.0 >= self.scroll + visible {
            self.cursor.0 = (self.scroll + visible.saturating_sub(1)).min(last_line);
            self.clamp_col();
        }
    }

    pub fn pan_vertical(&mut self, delta: i32) {
        let max_scroll = self.max_user_scroll();
        if delta < 0 {
            self.scroll = self.scroll.saturating_sub((-delta) as usize);
        } else {
            self.scroll = (self.scroll + delta as usize).min(max_scroll);
        }
    }

    pub fn pan_horizontal(&mut self, delta: i32) {
        if self.wrap {
            return;
        }
        let max_width = self
            .lines
            .iter()
            .map(|line| line.chars().count())
            .max()
            .unwrap_or(0);
        let max_scroll_x = max_width.saturating_sub(self.viewport_width.max(1));
        if delta < 0 {
            self.scroll_x = self.scroll_x.saturating_sub((-delta) as usize);
        } else {
            self.scroll_x = (self.scroll_x + delta as usize).min(max_scroll_x);
        }
    }

    pub fn jump_up(&mut self) {
        self.clear_selection();
        for _ in 0..5 {
            if self.wrap {
                if !self.move_up_wrapped() {
                    break;
                }
            } else if self.cursor.0 > 0 {
                self.cursor.0 -= 1;
                self.clamp_col();
            } else {
                break;
            }
        }
        self.preferred_col = Some(self.cursor.1);
        self.ensure_visible();
    }

    pub fn jump_down(&mut self) {
        self.clear_selection();
        for _ in 0..5 {
            if self.wrap {
                if !self.move_down_wrapped() {
                    break;
                }
            } else if self.cursor.0 < self.lines.len().saturating_sub(1) {
                self.cursor.0 += 1;
                self.clamp_col();
            } else {
                break;
            }
        }
        self.preferred_col = Some(self.cursor.1);
        self.ensure_visible();
    }

    pub fn word_left(&mut self) {
        self.ensure_invariants();
        self.clear_selection();
        let line = &self.lines[self.cursor.0];
        let bytes = line.as_bytes();
        if self.cursor.1 == 0 {
            if self.cursor.0 > 0 {
                self.cursor.0 -= 1;
                self.cursor.1 = self.current_line_len();
                self.ensure_visible();
            }
            return;
        }
        let mut col = self.cursor.1.min(line.len());
        while col > 0 && !bytes[col - 1].is_ascii_alphanumeric() && bytes[col - 1] != b'_' {
            col -= 1;
        }
        while col > 0 && (bytes[col - 1].is_ascii_alphanumeric() || bytes[col - 1] == b'_') {
            col -= 1;
        }
        self.cursor.1 = col;
        self.preferred_col = None;
        self.ensure_visible_h();
    }

    pub fn word_right(&mut self) {
        self.ensure_invariants();
        self.clear_selection();
        let line = &self.lines[self.cursor.0];
        let len = line.len();
        let bytes = line.as_bytes();
        if self.cursor.1 >= len {
            if self.cursor.0 < self.lines.len() - 1 {
                self.cursor.0 += 1;
                self.cursor.1 = 0;
                self.ensure_visible();
            }
            return;
        }
        let mut col = self.cursor.1;
        while col < len && (bytes[col].is_ascii_alphanumeric() || bytes[col] == b'_') {
            col += 1;
        }
        while col < len && !bytes[col].is_ascii_alphanumeric() && bytes[col] != b'_' {
            col += 1;
        }
        self.cursor.1 = col;
        self.preferred_col = None;
        self.ensure_visible_h();
    }

    pub fn goto_top(&mut self) {
        self.clear_selection();
        self.cursor = (0, 0);
        self.scroll = 0;
        self.scroll_x = 0;
        self.preferred_col = None;
    }

    pub fn goto_bottom(&mut self) {
        self.clear_selection();
        self.cursor.0 = self.lines.len().saturating_sub(1);
        self.cursor.1 = 0;
        self.preferred_col = None;
        self.ensure_visible();
    }

    pub fn goto_line(&mut self, line: usize) {
        self.clear_selection();
        self.cursor.0 = line.min(self.lines.len().saturating_sub(1));
        self.clamp_col();
        self.preferred_col = None;
        self.center_cursor();
    }

    pub fn insert_char(&mut self, c: char) {
        self.ensure_invariants();
        if self.has_extra_cursors() && !self.has_selection() {
            self.insert_text_multi(&c.to_string());
            return;
        }
        self.begin_edit_coalesced(EditKind::Insert);
        if self.has_selection() {
            self.delete_selection_internal();
        }
        self.cursor.0 = self.cursor.0.min(self.lines.len().saturating_sub(1));
        let col = self.cursor.1.min(self.lines[self.cursor.0].len());
        self.lines[self.cursor.0].insert(col, c);
        self.cursor.1 = col + 1;
        self.preferred_col = None;
        self.finish_edit();
    }

    pub fn insert_text(&mut self, text: &str) {
        self.ensure_invariants();
        if self.has_extra_cursors() && !self.has_selection() {
            self.insert_text_multi(text);
            return;
        }
        self.begin_edit();
        if self.has_selection() {
            self.delete_selection_internal();
        }
        for c in text.chars() {
            if c == '\n' || c == '\r' {
                self.insert_newline_internal();
            } else {
                let col = self.cursor.1.min(self.lines[self.cursor.0].len());
                self.lines[self.cursor.0].insert(col, c);
                self.cursor.1 = col + 1;
                self.preferred_col = None;
            }
        }
        self.finish_edit();
    }

    pub fn insert_newline(&mut self) {
        self.ensure_invariants();
        if self.has_extra_cursors() && !self.has_selection() {
            self.insert_text_multi("\n");
            return;
        }
        self.begin_edit();
        if self.has_selection() {
            self.delete_selection_internal();
        }
        self.insert_newline_internal();
        self.finish_edit();
    }

    pub fn delete_line(&mut self) {
        self.begin_edit();
        if self.has_selection() {
            self.delete_selection_internal();
        } else if self.lines.len() > 1 {
            self.lines.remove(self.cursor.0);
            if self.cursor.0 >= self.lines.len() {
                self.cursor.0 = self.lines.len() - 1;
            }
            self.clamp_col();
        } else {
            self.lines[0].clear();
            self.cursor.1 = 0;
        }
        self.finish_edit();
    }

    pub fn duplicate_line(&mut self) {
        self.begin_edit();
        let dup = self.lines[self.cursor.0].clone();
        self.lines.insert(self.cursor.0 + 1, dup);
        self.cursor.0 += 1;
        self.finish_edit();
    }

    pub fn backspace(&mut self) {
        self.ensure_invariants();
        if self.has_extra_cursors() && !self.has_selection() {
            self.delete_backspace_multi();
            return;
        }
        if self.has_selection() {
            self.begin_edit();
            self.delete_selection_internal();
            self.finish_edit();
            return;
        }
        if self.cursor.1 > 0 {
            self.begin_edit_coalesced(EditKind::Delete);
            let col = self.cursor.1.min(self.lines[self.cursor.0].len());
            if col > 0 {
                self.lines[self.cursor.0].remove(col - 1);
                self.cursor.1 = col - 1;
            }
            self.finish_edit();
        } else if self.cursor.0 > 0 {
            self.begin_edit_coalesced(EditKind::Delete);
            let current = self.lines.remove(self.cursor.0);
            self.cursor.0 -= 1;
            self.cursor.1 = self.lines[self.cursor.0].len();
            self.lines[self.cursor.0].push_str(&current);
            self.finish_edit();
        }
    }

    pub fn delete_char(&mut self) {
        self.ensure_invariants();
        if self.has_extra_cursors() && !self.has_selection() {
            self.delete_forward_multi();
            return;
        }
        self.begin_edit_coalesced(EditKind::Delete);
        if self.has_selection() {
            self.delete_selection_internal();
            self.finish_edit();
            return;
        }
        let len = self.current_line_len();
        if self.cursor.1 < len {
            self.lines[self.cursor.0].remove(self.cursor.1);
        } else if self.cursor.0 < self.lines.len() - 1 {
            let next = self.lines.remove(self.cursor.0 + 1);
            self.lines[self.cursor.0].push_str(&next);
        }
        self.finish_edit();
    }

    pub fn undo(&mut self) -> bool {
        self.last_edit_kind = None;
        let Some(snapshot) = self.undo_stack.pop() else {
            return false;
        };
        self.redo_stack.push(self.snapshot());
        self.restore(snapshot);
        true
    }

    pub fn redo(&mut self) -> bool {
        self.last_edit_kind = None;
        let Some(snapshot) = self.redo_stack.pop() else {
            return false;
        };
        self.undo_stack.push(self.snapshot());
        self.restore(snapshot);
        true
    }

    pub fn start_selection(&mut self, pos: (usize, usize)) {
        self.cursor = pos;
        self.preferred_col = None;
        self.selection = Some(Selection {
            anchor: pos,
            cursor: pos,
        });
        self.ensure_visible();
    }

    pub fn update_selection(&mut self, pos: (usize, usize)) {
        self.cursor = pos;
        self.preferred_col = None;
        if let Some(sel) = &mut self.selection {
            sel.cursor = pos;
        } else {
            self.selection = Some(Selection {
                anchor: pos,
                cursor: pos,
            });
        }
        self.ensure_visible();
    }

    pub fn clear_selection(&mut self) {
        self.selection = None;
    }

    pub fn clear_extra_cursors(&mut self) {
        self.extra_cursors.clear();
    }

    pub fn place_cursor(&mut self, pos: (usize, usize)) {
        self.cursor = pos;
        self.preferred_col = None;
        self.selection = None;
        self.extra_cursors.clear();
        self.ensure_visible();
    }

    pub fn add_cursor(&mut self, pos: (usize, usize)) {
        let pos = self.clamp_position(pos);
        if pos == self.cursor || self.extra_cursors.contains(&pos) {
            return;
        }
        self.extra_cursors.push(pos);
        self.extra_cursors.sort_unstable();
    }

    pub fn toggle_cursor(&mut self, pos: (usize, usize)) -> bool {
        let pos = self.clamp_position(pos);
        if pos == self.cursor {
            return false;
        }
        if let Some(idx) = self.extra_cursors.iter().position(|&cursor| cursor == pos) {
            self.extra_cursors.remove(idx);
            true
        } else {
            self.extra_cursors.push(pos);
            self.extra_cursors.sort_unstable();
            true
        }
    }

    pub fn set_column_cursors(&mut self, anchor: (usize, usize), head: (usize, usize)) -> usize {
        let anchor = self.clamp_position(anchor);
        let head = self.clamp_position(head);
        let (start_line, end_line) = if anchor.0 <= head.0 {
            (anchor.0, head.0)
        } else {
            (head.0, anchor.0)
        };
        let desired_col = head.1;
        self.selection = None;
        self.extra_cursors.clear();
        self.cursor = (
            head.0,
            desired_col.min(self.lines[head.0].chars().count()),
        );
        for line in start_line..=end_line {
            let pos = (line, desired_col.min(self.lines[line].chars().count()));
            if pos != self.cursor {
                self.extra_cursors.push(pos);
            }
        }
        self.extra_cursors.sort_unstable();
        self.extra_cursors.dedup();
        self.preferred_col = None;
        self.ensure_visible();
        self.extra_cursors.len() + 1
    }

    pub fn add_cursor_above(&mut self) -> usize {
        self.add_vertical_cursors(-1)
    }

    pub fn add_cursor_below(&mut self) -> usize {
        self.add_vertical_cursors(1)
    }

    pub fn select_left(&mut self) {
        self.extend_selection_motion(Self::move_left);
    }

    pub fn select_right(&mut self) {
        self.extend_selection_motion(Self::move_right);
    }

    pub fn select_up(&mut self) {
        self.extend_selection_motion(Self::move_up);
    }

    pub fn select_down(&mut self) {
        self.extend_selection_motion(Self::move_down);
    }

    pub fn select_home(&mut self) {
        self.extend_selection_motion(Self::move_home);
    }

    pub fn select_end(&mut self) {
        self.extend_selection_motion(Self::move_end);
    }

    pub fn select_page_up(&mut self) {
        self.extend_selection_motion(Self::page_up);
    }

    pub fn select_page_down(&mut self) {
        self.extend_selection_motion(Self::page_down);
    }

    pub fn select_word_left(&mut self) {
        self.extend_selection_motion(Self::word_left);
    }

    pub fn select_word_right(&mut self) {
        self.extend_selection_motion(Self::word_right);
    }

    pub fn select_top(&mut self) {
        self.extend_selection_motion(Self::goto_top);
    }

    pub fn select_bottom(&mut self) {
        self.extend_selection_motion(Self::goto_bottom);
    }

    pub fn selected_text(&self) -> Option<String> {
        let (start, end) = self.selection_bounds()?;
        let text = self.document_text();
        let chars: Vec<char> = text.chars().collect();
        let start_off = self.position_to_offset(start);
        let end_off = self.position_to_offset(end);
        Some(chars[start_off..end_off].iter().collect())
    }

    #[allow(dead_code)]
    pub fn selection_set(&self) -> SelectionSet {
        match self.selection_bounds() {
            Some((start, end)) => SelectionSet::from_ranges(vec![SelectionRange::new(start, end)]),
            None => SelectionSet::new(),
        }
    }

    #[allow(dead_code)]
    pub fn selected_texts_for(&self, set: &SelectionSet) -> Vec<String> {
        let text = self.document_text();
        let chars: Vec<char> = text.chars().collect();
        let mut out = Vec::new();

        for range in set.normalized_ranges() {
            let (start, end) = range.normalized();
            let start_off = self.position_to_offset(start);
            let end_off = self.position_to_offset(end);
            out.push(chars[start_off..end_off].iter().collect());
        }

        out
    }

    #[allow(dead_code)]
    pub fn copy_selection_set(&self, set: &SelectionSet) -> String {
        self.selected_texts_for(set).join("\n")
    }

    #[allow(dead_code)]
    pub fn delete_selection_set(&mut self, set: &SelectionSet) -> usize {
        self.replace_selection_set(set, &[])
    }

    #[allow(dead_code)]
    pub fn replace_selection_set(&mut self, set: &SelectionSet, replacements: &[String]) -> usize {
        let ranges = set.normalized_ranges();
        if ranges.is_empty() {
            return 0;
        }

        self.begin_edit();
        let mut chars: Vec<char> = self.document_text().chars().collect();
        let mut spans: Vec<(usize, usize)> = ranges
            .iter()
            .map(|range| {
                let (start, end) = range.normalized();
                (self.position_to_offset(start), self.position_to_offset(end))
            })
            .collect();
        spans.sort_by_key(|(start, _)| *start);

        let mut applied = 0usize;
        for (idx, (start, end)) in spans.into_iter().enumerate().rev() {
            let replacement = replacements
                .get(idx)
                .map(|s| s.chars().collect::<Vec<char>>())
                .unwrap_or_default();
            chars.splice(start..end, replacement);
            applied += 1;
        }

        let rebuilt: String = chars.into_iter().collect();
        self.set_document_text(rebuilt);
        if let Some(first) = ranges.first() {
            let (start, end) = first.normalized();
            self.cursor = end;
            self.selection = Some(Selection {
                anchor: start,
                cursor: end,
            });
        } else {
            self.selection = None;
        }
        self.preferred_col = None;
        self.dirty = true;
        if let Some(query) = self.search_query.clone() {
            self.set_search_query(query);
        }
        self.finish_edit();
        applied
    }

    pub fn cut_selection(&mut self) -> Option<String> {
        let text = self.selected_text()?;
        self.begin_edit();
        self.delete_selection_internal();
        self.finish_edit();
        Some(text)
    }

    pub fn replace_all(&mut self, query: &str, replacement: &str) -> usize {
        if query.is_empty() {
            return 0;
        }
        self.replace_query = Some(query.to_string());
        self.replace_with = Some(replacement.to_string());
        let total = self
            .lines
            .iter()
            .map(|line| line.matches(query).count())
            .sum::<usize>();
        if total == 0 {
            self.set_search_query(query.to_string());
            self.replace_query = Some(query.to_string());
            return 0;
        }
        self.begin_edit();
        for line in &mut self.lines {
            *line = line.replace(query, replacement);
        }
        self.replace_query = Some(query.to_string());
        self.set_search_query(query.to_string());
        self.finish_edit();
        total
    }

    pub fn add_next_occurrence_cursor(&mut self) -> bool {
        let query = match self.current_find_query().or_else(|| self.select_current_word()) {
            Some(q) => q,
            None => return false,
        };
        let current_selection = self.selection_bounds();
        self.set_search_query(query.clone());
        self.restore_active_match(current_selection);
        let start_idx = if self.search_matches.is_empty() {
            0
        } else {
            (self.active_match + 1) % self.search_matches.len()
        };
        for offset in 0..self.search_matches.len() {
            let idx = (start_idx + offset) % self.search_matches.len();
            let m = self.search_matches[idx];
            let pos = (m.line, m.end);
            let match_range = ((m.line, m.start), (m.line, m.end));
            if current_selection == Some(match_range) {
                continue;
            }
            if pos != self.cursor && !self.extra_cursors.contains(&pos) {
                self.active_match = idx;
                self.add_cursor(pos);
                return true;
            }
        }
        false
    }

    pub fn add_prev_occurrence_cursor(&mut self) -> bool {
        let query = match self.current_find_query().or_else(|| self.select_current_word()) {
            Some(q) => q,
            None => return false,
        };
        let current_selection = self.selection_bounds();
        self.set_search_query(query);
        self.restore_active_match(current_selection);
        if self.search_matches.is_empty() {
            return false;
        }
        let start_idx = (self.active_match + self.search_matches.len() - 1) % self.search_matches.len();
        for offset in 0..self.search_matches.len() {
            let idx = (start_idx + self.search_matches.len() - offset) % self.search_matches.len();
            let m = self.search_matches[idx];
            let pos = (m.line, m.end);
            let match_range = ((m.line, m.start), (m.line, m.end));
            if current_selection == Some(match_range) {
                continue;
            }
            if pos != self.cursor && !self.extra_cursors.contains(&pos) {
                self.active_match = idx;
                self.add_cursor(pos);
                return true;
            }
        }
        false
    }

    pub fn add_all_occurrence_cursors(&mut self) -> usize {
        let query = match self.current_find_query().or_else(|| self.select_current_word()) {
            Some(q) => q,
            None => return 0,
        };
        let current_selection = self.selection_bounds();
        self.set_search_query(query);
        self.restore_active_match(current_selection);
        self.extra_cursors.clear();
        for m in &self.search_matches {
            let pos = (m.line, m.end);
            let match_range = ((m.line, m.start), (m.line, m.end));
            if Some(match_range) == current_selection {
                continue;
            }
            if pos != self.cursor && !self.extra_cursors.contains(&pos) {
                self.extra_cursors.push(pos);
            }
        }
        self.extra_cursors.sort_unstable();
        self.extra_cursors.len()
    }

    pub fn replace_current_match(&mut self) -> bool {
        let Some(replacement) = self.replace_with.clone() else {
            return false;
        };
        let Some(query) = self.current_find_query() else {
            return false;
        };
        if self.search_matches.is_empty() {
            self.set_search_query(query.clone());
        }
        let Some(m) = self.search_matches.get(self.active_match).copied() else {
            return false;
        };
        self.begin_edit();
        let mut chars: Vec<char> = self.document_text().chars().collect();
        let start = self.position_to_offset((m.line, m.start));
        let end = self.position_to_offset((m.line, m.end));
        chars.splice(start..end, replacement.chars());
        self.set_document_text(chars.into_iter().collect());
        self.replace_query = Some(query.clone());
        self.set_search_query(query);
        let new_pos = Self::offset_to_position(&self.lines, start + replacement.chars().count());
        self.cursor = new_pos;
        self.selection = None;
        self.extra_cursors.clear();
        self.preferred_col = None;
        self.dirty = true;
        self.ensure_visible();
        true
    }

    pub fn replace_current_and_next(&mut self) -> bool {
        if !self.replace_current_match() {
            return false;
        }
        let _ = self.next_search_match();
        true
    }

    pub fn replace_all_current(&mut self) -> Option<usize> {
        let query = self.current_find_query()?;
        let replacement = self.replace_with.clone()?;
        Some(self.replace_all(&query, &replacement))
    }

    pub fn extend_selection_to(&mut self, pos: (usize, usize)) {
        self.preferred_col = None;
        if let Some(sel) = &mut self.selection {
            sel.cursor = pos;
        } else {
            self.selection = Some(Selection {
                anchor: self.cursor,
                cursor: pos,
            });
        }
        self.cursor = pos;
        self.ensure_visible();
    }

    pub fn selection_contains(&self, pos: (usize, usize)) -> bool {
        let Some((start, end)) = self.selection_bounds() else {
            return false;
        };
        pos >= start && pos < end
    }

    pub fn select_word_at(&mut self, pos: (usize, usize)) {
        let line = self.lines.get(pos.0).cloned().unwrap_or_default();
        let chars: Vec<char> = line.chars().collect();
        if chars.is_empty() {
            self.place_cursor((pos.0, 0));
            return;
        }
        let idx = pos.1.min(chars.len().saturating_sub(1));
        let is_word = |c: char| c.is_ascii_alphanumeric() || c == '_';
        let mut start = idx;
        let mut end = idx;
        let target_is_word = is_word(chars[idx]);
        while start > 0 && is_word(chars[start - 1]) == target_is_word {
            start -= 1;
        }
        while end + 1 < chars.len() && is_word(chars[end + 1]) == target_is_word {
            end += 1;
        }
        self.cursor = (pos.0, end + 1);
        self.selection = Some(Selection {
            anchor: (pos.0, start),
            cursor: (pos.0, end + 1),
        });
        self.preferred_col = None;
        self.ensure_visible();
    }

    pub fn select_line_at(&mut self, line: usize) {
        let line = line.min(self.lines.len().saturating_sub(1));
        let len = self.lines[line].chars().count();
        self.cursor = (line, len);
        self.selection = Some(Selection {
            anchor: (line, 0),
            cursor: (line, len),
        });
        self.preferred_col = None;
        self.ensure_visible();
    }

    pub fn select_current_line(&mut self) {
        self.select_line_at(self.cursor.0);
    }

    pub fn move_lines_up(&mut self) -> bool {
        let (start, end) = self.selected_line_range();
        if start == 0 || end >= self.lines.len() {
            return false;
        }
        self.begin_edit();
        let moved: Vec<String> = self.lines.drain(start..=end).collect();
        let insert_at = start - 1;
        for (offset, line) in moved.into_iter().enumerate() {
            self.lines.insert(insert_at + offset, line);
        }
        let new_start = start - 1;
        let new_end = new_start + (end - start);
        self.cursor.0 = self.cursor.0.saturating_sub(1);
        self.selection = if self.has_selection() {
            Some(Selection {
                anchor: (new_start, 0),
                cursor: (new_end, self.lines[new_end].len()),
            })
        } else {
            None
        };
        self.finish_edit();
        true
    }

    pub fn move_lines_down(&mut self) -> bool {
        let (start, end) = self.selected_line_range();
        if end + 1 >= self.lines.len() {
            return false;
        }
        self.begin_edit();
        let moved: Vec<String> = self.lines.drain(start..=end).collect();
        let insert_at = start + 1;
        for (offset, line) in moved.into_iter().enumerate() {
            self.lines.insert(insert_at + offset, line);
        }
        let new_start = start + 1;
        let new_end = new_start + (end - start);
        self.cursor.0 = (self.cursor.0 + 1).min(self.lines.len().saturating_sub(1));
        self.selection = if self.has_selection() {
            Some(Selection {
                anchor: (new_start, 0),
                cursor: (new_end, self.lines[new_end].len()),
            })
        } else {
            None
        };
        self.finish_edit();
        true
    }

    pub fn move_selected_text_to(&mut self, pos: (usize, usize)) -> bool {
        let Some((start, end)) = self.selection_bounds() else {
            return false;
        };
        if pos >= start && pos <= end {
            return false;
        }

        self.begin_edit();
        let text = self.document_text();
        let chars: Vec<char> = text.chars().collect();
        let start_off = self.position_to_offset(start);
        let end_off = self.position_to_offset(end);
        let drop_off = self.position_to_offset(pos);
        let selected: Vec<char> = chars[start_off..end_off].to_vec();

        let mut rest = chars;
        rest.drain(start_off..end_off);
        let adjusted_drop = if drop_off > end_off {
            drop_off - (end_off - start_off)
        } else {
            drop_off
        };
        rest.splice(adjusted_drop..adjusted_drop, selected.iter().copied());

        let moved_len = selected.len();
        let rebuilt: String = rest.into_iter().collect();
        self.set_document_text(rebuilt);
        let new_start = Self::offset_to_position(&self.lines, adjusted_drop);
        let new_end = Self::offset_to_position(&self.lines, adjusted_drop + moved_len);
        self.cursor = new_end;
        self.selection = Some(Selection {
            anchor: new_start,
            cursor: new_end,
        });
        self.preferred_col = None;
        self.dirty = true;
        if let Some(query) = self.search_query.clone() {
            self.set_search_query(query);
        }
        self.ensure_visible();
        true
    }

    #[allow(dead_code)]
    pub fn move_ranges_to(&mut self, set: &SelectionSet, pos: (usize, usize)) -> bool {
        let ranges = set.normalized_ranges();
        if ranges.is_empty() {
            return false;
        }

        let text = self.copy_selection_set(set);
        let chars: Vec<char> = self.document_text().chars().collect();
        let insert_at = self.position_to_offset(pos);
        let mut source_spans: Vec<(usize, usize)> = ranges
            .iter()
            .map(|range| {
                let (start, end) = range.normalized();
                (self.position_to_offset(start), self.position_to_offset(end))
            })
            .collect();
        source_spans.sort_by_key(|(start, _)| *start);

        let mut adjusted_insert = insert_at;
        for (start, end) in source_spans.iter().rev() {
            if adjusted_insert >= *start && adjusted_insert <= *end {
                return false;
            }
        }

        let mut rebuilt = chars;
        for (start, end) in source_spans.into_iter().rev() {
            rebuilt.drain(start..end);
            if adjusted_insert > end {
                adjusted_insert -= end - start;
            }
        }
        rebuilt.splice(adjusted_insert..adjusted_insert, text.chars());

        self.begin_edit();
        self.set_document_text(rebuilt.into_iter().collect());
        self.cursor = Self::offset_to_position(&self.lines, adjusted_insert + text.chars().count());
        self.selection = Some(Selection {
            anchor: Self::offset_to_position(&self.lines, adjusted_insert),
            cursor: self.cursor,
        });
        self.preferred_col = None;
        self.dirty = true;
        if let Some(query) = self.search_query.clone() {
            self.set_search_query(query);
        }
        self.finish_edit();
        true
    }

    pub fn mouse_position(&self, col: u16, row: u16) -> Option<(usize, usize)> {
        let inner = self.last_inner?;
        if col < inner.x + self.last_gutter_w
            || col >= inner.x + inner.width
            || row < inner.y
            || row >= inner.y + inner.height.saturating_sub(self.footer_rows() as u16)
        {
            return None;
        }
        let target_row = row.saturating_sub(inner.y) as usize;
        let content_col = col.saturating_sub(inner.x + self.last_gutter_w) as usize;
        let visible_rows = self.usable_viewport_height();
        let mut row_y = 0usize;
        let mut line_idx = self.scroll;

        while line_idx < self.lines.len() && row_y < visible_rows {
            let line = &self.lines[line_idx];
            let total_chars = line.chars().count();
            let chunks = if self.wrap && self.viewport_width > 0 {
                total_chars.max(1).div_ceil(self.viewport_width)
            } else {
                1
            };

            for chunk_i in 0..chunks {
                if row_y == target_row {
                    let chunk_start = if self.wrap {
                        chunk_i * self.viewport_width
                    } else {
                        self.scroll_x
                    };
                    let chunk_end = if self.wrap {
                        (chunk_start + self.viewport_width).min(total_chars)
                    } else {
                        (self.scroll_x + self.viewport_width).min(total_chars)
                    };
                    let target =
                        chunk_start + content_col.min(chunk_end.saturating_sub(chunk_start));
                    return Some((line_idx, target.min(total_chars)));
                }
                row_y += 1;
                if row_y >= visible_rows {
                    break;
                }
            }
            line_idx += 1;
        }

        None
    }

    pub fn next_search_match(&mut self) -> bool {
        if self.search_matches.is_empty() {
            return false;
        }
        self.active_match = (self.active_match + 1) % self.search_matches.len();
        self.goto_search_match(self.active_match);
        true
    }

    pub fn prev_search_match(&mut self) -> bool {
        if self.search_matches.is_empty() {
            return false;
        }
        self.active_match =
            (self.active_match + self.search_matches.len() - 1) % self.search_matches.len();
        self.goto_search_match(self.active_match);
        true
    }

    fn current_line_len(&self) -> usize {
        self.lines.get(self.cursor.0).map_or(0, |l| l.len())
    }

    fn clamp_col(&mut self) {
        let len = self.current_line_len();
        if self.cursor.1 > len {
            self.cursor.1 = len;
        }
    }

    fn ensure_visible(&mut self) {
        let visible = self.usable_viewport_height();
        let margin = visible.min(6) / 2;
        if self.cursor.0 < self.scroll.saturating_add(margin) {
            self.scroll = self.cursor.0.saturating_sub(margin);
        } else {
            let lower_bound = self
                .scroll
                .saturating_add(visible.saturating_sub(1).saturating_sub(margin));
            if self.cursor.0 > lower_bound {
                self.scroll = self
                    .cursor
                    .0
                    .saturating_sub(visible.saturating_sub(1).saturating_sub(margin));
            }
        }
        self.clamp_scroll();
        self.ensure_visible_h();
    }

    fn center_cursor(&mut self) {
        let visible = self.usable_viewport_height();
        self.scroll = self.cursor.0.saturating_sub(visible / 2);
        self.clamp_scroll();
        self.ensure_visible_h();
    }

    fn ensure_visible_h(&mut self) {
        if self.wrap {
            self.scroll_x = 0;
            return;
        }
        let margin = 4usize;
        let w = self.viewport_width;
        if w == 0 {
            return;
        }
        if self.cursor.1 < self.scroll_x + margin {
            self.scroll_x = self.cursor.1.saturating_sub(margin);
        }
        if self.cursor.1 >= self.scroll_x + w.saturating_sub(margin) {
            self.scroll_x = self.cursor.1 + margin + 1 - w;
        }
    }

    fn footer_rows(&self) -> usize {
        let mut rows = usize::from(self.prompt_mode.is_some() || self.ai_status.is_some());
        if self.replace_open { rows += 2; }
        rows
    }

    fn usable_viewport_height(&self) -> usize {
        self.viewport_height
            .saturating_sub(self.footer_rows())
            .max(1)
    }

    /// Greatest valid `scroll` value so the end of the file stays reachable.
    ///
    /// Without wrap this is just `lines - visible`. With wrap, a single
    /// logical line may occupy multiple screen rows, so that formula caps
    /// scroll too early and leaves trailing lines permanently off-screen.
    /// Here we walk logical lines from the end, summing wrapped heights
    /// until they fill the viewport, and return the earliest line index
    /// whose content still fits — guaranteeing the last line is reachable.
    fn max_scroll(&self) -> usize {
        if self.lines.is_empty() {
            return 0;
        }
        let visible = self.usable_viewport_height();
        if !self.wrap || self.viewport_width == 0 {
            return self.lines.len().saturating_sub(visible);
        }
        let mut rows = 0usize;
        let mut count = 0usize;
        for line in self.lines.iter().rev() {
            let wrapped = line.chars().count().max(1).div_ceil(self.viewport_width);
            if rows + wrapped > visible {
                break;
            }
            rows += wrapped;
            count += 1;
        }
        // Even if a single line exceeds the viewport, the user must still
        // be able to scroll it to the top.
        self.lines.len().saturating_sub(count.max(1))
    }

    /// Like `max_scroll`, but allows overscroll so the last line can be
    /// dragged all the way up to the top of the viewport. This is what
    /// keyboard- and wheel-driven scrolls clamp to — cursor-following
    /// scrolls (`ensure_visible`/`clamp_scroll`) still use `max_scroll`
    /// so the cursor stays anchored to real content.
    fn max_user_scroll(&self) -> usize {
        self.lines.len().saturating_sub(1)
    }

    fn clamp_scroll(&mut self) {
        self.scroll = self.scroll.min(self.max_scroll());
    }

    fn snapshot(&self) -> Snapshot {
        Snapshot {
            lines: self.lines.clone(),
            cursor: self.cursor,
            scroll: self.scroll,
            scroll_x: self.scroll_x,
            selection: self.selection,
        }
    }

    fn restore(&mut self, snapshot: Snapshot) {
        self.lines = snapshot.lines;
        self.cursor = snapshot.cursor;
        self.scroll = snapshot.scroll;
        self.scroll_x = snapshot.scroll_x;
        self.preferred_col = None;
        self.selection = snapshot.selection;
        self.clamp_col();
        self.clamp_scroll();
        if let Some(query) = self.search_query.clone() {
            self.set_search_query(query);
        }
        self.dirty = true;
    }

    fn begin_edit(&mut self) {
        self.last_edit_kind = None;
        self.undo_stack.push(self.snapshot());
        if self.undo_stack.len() > MAX_UNDO_STACK {
            self.undo_stack.drain(0..self.undo_stack.len() - MAX_UNDO_STACK);
        }
        self.redo_stack.clear();
    }

    /// Like `begin_edit`, but coalesces consecutive edits of the same kind
    /// into a single undo entry. For example, typing "hello" produces one
    /// undo snapshot instead of five.
    fn begin_edit_coalesced(&mut self, kind: EditKind) {
        if self.last_edit_kind == Some(kind) {
            // Same kind of edit as last time -- reuse the existing snapshot.
            // Still clear redo since the document is changing.
            self.redo_stack.clear();
            return;
        }
        self.last_edit_kind = Some(kind);
        self.undo_stack.push(self.snapshot());
        if self.undo_stack.len() > MAX_UNDO_STACK {
            self.undo_stack.drain(0..self.undo_stack.len() - MAX_UNDO_STACK);
        }
        self.redo_stack.clear();
    }

    fn finish_edit(&mut self) {
        if self.lines.is_empty() {
            self.lines.push(String::new());
        }
        self.selection = None;
        self.preferred_col = None;
        self.dirty = true;
        if let Some(query) = self.search_query.clone() {
            self.set_search_query(query);
        }
        self.ensure_visible();
    }

    fn insert_newline_internal(&mut self) {
        let line = self.cursor.0;
        let col = self.cursor.1.min(self.lines[line].len());
        let indent: String = self.lines[line]
            .chars()
            .take_while(|c| *c == ' ' || *c == '\t')
            .collect();
        let rest = self.lines[line][col..].to_string();
        self.lines[line].truncate(col);
        let new_line = format!("{}{}", indent, rest);
        let indent_len = indent.len();
        self.lines.insert(line + 1, new_line);
        self.cursor.0 += 1;
        self.cursor.1 = indent_len;
    }

    fn delete_selection_internal(&mut self) {
        let Some((start, end)) = self.selection_bounds() else {
            return;
        };
        let prefix = self.lines[start.0][..start.1].to_string();
        let suffix = self.lines[end.0][end.1..].to_string();
        self.lines
            .splice(start.0..=end.0, [format!("{}{}", prefix, suffix)]);
        self.cursor = start;
        self.preferred_col = None;
        self.selection = None;
    }

    fn selection_bounds(&self) -> Option<((usize, usize), (usize, usize))> {
        let selection = self.selection?;
        if selection.anchor == selection.cursor {
            None
        } else {
            Some(selection.normalized())
        }
    }

    fn extend_selection_motion(&mut self, motion: fn(&mut Self)) {
        let anchor = self.selection.map(|s| s.anchor).unwrap_or(self.cursor);
        motion(self);
        if self.cursor == anchor {
            self.selection = None;
        } else {
            self.selection = Some(Selection {
                anchor,
                cursor: self.cursor,
            });
        }
    }

    fn document_text(&self) -> String {
        self.lines.join("\n")
    }

    fn set_document_text(&mut self, text: String) {
        self.lines = text.split('\n').map(|s| s.to_string()).collect();
        if self.lines.is_empty() {
            self.lines.push(String::new());
        }
    }

    fn position_to_offset(&self, pos: (usize, usize)) -> usize {
        let mut offset = 0usize;
        for (idx, line) in self.lines.iter().enumerate() {
            if idx == pos.0 {
                return offset + pos.1.min(line.chars().count());
            }
            offset += line.chars().count() + 1;
        }
        offset
    }

    fn offset_to_position(lines: &[String], offset: usize) -> (usize, usize) {
        let mut remaining = offset;
        for (line_idx, line) in lines.iter().enumerate() {
            let len = line.chars().count();
            if remaining <= len {
                return (line_idx, remaining);
            }
            remaining = remaining.saturating_sub(len + 1);
        }
        let last = lines.len().saturating_sub(1);
        (
            last,
            lines.get(last).map(|l| l.chars().count()).unwrap_or(0),
        )
    }

    fn selected_line_range(&self) -> (usize, usize) {
        if let Some((start, end)) = self.selection_bounds() {
            let end_line = if end.1 == 0 && end.0 > start.0 {
                end.0 - 1
            } else {
                end.0
            };
            (start.0, end_line)
        } else {
            (self.cursor.0, self.cursor.0)
        }
    }

    fn current_find_query(&self) -> Option<String> {
        if let Some(q) = self.search_query.clone().filter(|q| !q.is_empty()) {
            return Some(q);
        }
        self.selected_text()
            .filter(|text| !text.is_empty() && !text.contains('\n'))
    }

    fn current_find_seed(&self) -> Option<String> {
        self.selected_text()
            .filter(|text| !text.is_empty() && !text.contains('\n'))
            .or_else(|| self.current_word_text(self.cursor))
    }

    fn current_word_bounds(&self, pos: (usize, usize)) -> Option<((usize, usize), (usize, usize))> {
        let line = self.lines.get(pos.0)?;
        let chars: Vec<char> = line.chars().collect();
        if chars.is_empty() {
            return None;
        }
        let idx = pos.1.min(chars.len().saturating_sub(1));
        let is_word = |c: char| c.is_ascii_alphanumeric() || c == '_';
        if !is_word(chars[idx]) {
            return None;
        }
        let mut start = idx;
        let mut end = idx;
        while start > 0 && is_word(chars[start - 1]) {
            start -= 1;
        }
        while end + 1 < chars.len() && is_word(chars[end + 1]) {
            end += 1;
        }
        Some(((pos.0, start), (pos.0, end + 1)))
    }

    fn current_word_text(&self, pos: (usize, usize)) -> Option<String> {
        let (start, end) = self.current_word_bounds(pos)?;
        let line = self.lines.get(start.0)?;
        Some(
            line.chars()
                .skip(start.1)
                .take(end.1.saturating_sub(start.1))
                .collect(),
        )
    }

    fn clamp_position(&self, pos: (usize, usize)) -> (usize, usize) {
        let line = pos.0.min(self.lines.len().saturating_sub(1));
        let col = pos.1.min(self.lines[line].chars().count());
        (line, col)
    }

    fn sorted_cursor_positions(&self) -> Vec<(usize, usize)> {
        let mut positions = self.extra_cursors.clone();
        positions.push(self.cursor);
        positions.sort_unstable();
        positions.dedup();
        positions
    }

    fn move_all_cursors_with<F>(&mut self, mut f: F)
    where
        F: FnMut(&Self, (usize, usize)) -> (usize, usize),
    {
        let primary = self.clamp_position(f(self, self.cursor));
        let mut extras = self
            .extra_cursors
            .iter()
            .copied()
            .map(|pos| self.clamp_position(f(self, pos)))
            .filter(|&pos| pos != primary)
            .collect::<Vec<_>>();
        extras.sort_unstable();
        extras.dedup();
        self.cursor = primary;
        self.extra_cursors = extras;
        self.preferred_col = None;
        self.ensure_visible();
    }

    fn add_vertical_cursors(&mut self, delta: isize) -> usize {
        let before = self.sorted_cursor_positions();
        let mut added = 0usize;
        for pos in before {
            let next_line = pos.0 as isize + delta;
            if next_line < 0 || next_line >= self.lines.len() as isize {
                continue;
            }
            let line = next_line as usize;
            let col = pos.1.min(self.lines[line].chars().count());
            let next = (line, col);
            if next != self.cursor && !self.extra_cursors.contains(&next) {
                self.extra_cursors.push(next);
                added += 1;
            }
        }
        self.extra_cursors.sort_unstable();
        self.extra_cursors.dedup();
        added
    }

    fn select_current_word(&mut self) -> Option<String> {
        let (start, end) = self.current_word_bounds(self.cursor)?;
        self.selection = Some(Selection {
            anchor: start,
            cursor: end,
        });
        self.cursor = end;
        self.preferred_col = None;
        self.ensure_visible();
        self.selected_text()
    }

    fn sync_active_match_to_selection(&mut self) {
        let Some((start, end)) = self.selection_bounds() else {
            return;
        };
        self.sync_active_match_to_range((start, end));
    }

    fn sync_active_match_to_range(&mut self, range: ((usize, usize), (usize, usize))) {
        let (start, end) = range;
        if let Some(idx) = self
            .search_matches
            .iter()
            .position(|m| (m.line, m.start) == start && (m.line, m.end) == end)
        {
            self.active_match = idx;
        }
    }

    fn restore_active_match(&mut self, range: Option<((usize, usize), (usize, usize))>) {
        if let Some(range) = range {
            self.sync_active_match_to_range(range);
            self.goto_search_match(self.active_match);
        } else {
            self.sync_active_match_to_selection();
        }
    }

    fn preview_prompt(&mut self) {
        match self.prompt_mode {
            Some(PromptMode::Search) => {
                self.set_search_query_near_cursor(self.prompt_input.trim().to_string());
            }
            _ => {}
        }
    }

    fn set_search_query_near_cursor(&mut self, query: String) {
        let anchor = self
            .selection_bounds()
            .map(|(start, _)| start)
            .unwrap_or(self.cursor);
        self.set_search_query(query);
        if self.search_matches.is_empty() {
            return;
        }
        if let Some((idx, _)) = self
            .search_matches
            .iter()
            .enumerate()
            .min_by_key(|(_, m)| {
                let line_dist = m.line.abs_diff(anchor.0);
                let col_dist = m.start.abs_diff(anchor.1);
                (line_dist, col_dist)
            })
        {
            self.active_match = idx;
            self.goto_search_match(idx);
        }
    }

    fn insert_text_multi(&mut self, text: &str) {
        let positions = self.sorted_cursor_positions();
        if positions.is_empty() {
            return;
        }
        // Fast path: single-line text (covers every normal keystroke).
        // Work directly on self.lines to avoid O(file_size) round-trips
        // through document_text() / set_document_text().
        if !text.contains('\n') && !text.contains('\r') {
            self.begin_edit();
            let text_len = text.len();
            // Process cursors from bottom-right to top-left so that
            // insertions on earlier lines don't shift later line indices.
            // For cursors sharing a line, accumulate a column shift.
            let mut new_positions = Vec::with_capacity(positions.len());
            let mut prev_line = usize::MAX;
            let mut col_shift: usize = 0;
            for &(line, col) in positions.iter().rev() {
                if line != prev_line {
                    col_shift = 0;
                    prev_line = line;
                }
                let actual_col = col.min(self.lines[line].len()) + col_shift;
                self.lines[line].insert_str(actual_col, text);
                new_positions.push((line, actual_col + text_len));
                col_shift += text_len;
            }
            new_positions.reverse();
            self.cursor = new_positions.pop().unwrap_or((0, 0));
            self.extra_cursors = new_positions;
            self.preferred_col = None;
            self.dirty = true;
            if let Some(query) = self.search_query.clone() {
                self.set_search_query(query);
            }
            self.ensure_visible();
            return;
        }
        // Slow path: text contains newlines — fall back to flat-buffer approach.
        self.begin_edit();
        let mut chars: Vec<char> = self.document_text().chars().collect();
        let text_chars: Vec<char> = text.chars().collect();
        let mut new_offsets = Vec::with_capacity(positions.len());
        let mut shift = 0usize;
        for pos in positions {
            let offset = self.position_to_offset(pos) + shift;
            chars.splice(offset..offset, text_chars.iter().copied());
            let inserted = text_chars.len();
            new_offsets.push(offset + inserted);
            shift += inserted;
        }
        self.set_document_text(chars.into_iter().collect());
        let mut new_positions: Vec<(usize, usize)> = new_offsets
            .into_iter()
            .map(|off| Self::offset_to_position(&self.lines, off))
            .collect();
        self.cursor = new_positions.pop().unwrap_or((0, 0));
        self.extra_cursors = new_positions;
        self.preferred_col = None;
        self.dirty = true;
        if let Some(query) = self.search_query.clone() {
            self.set_search_query(query);
        }
        self.ensure_visible();
    }

    fn delete_backspace_multi(&mut self) {
        let positions = self.sorted_cursor_positions();
        if positions.iter().all(|&(_, col)| col == 0) {
            return;
        }
        // Fast path: all cursors have col > 0 (no cross-line join needed).
        // Delete directly from self.lines without rebuilding the document.
        if positions.iter().all(|&(_, col)| col > 0) {
            self.begin_edit();
            let mut new_positions = Vec::with_capacity(positions.len());
            let mut prev_line = usize::MAX;
            let mut col_shift: usize = 0;
            // Process from bottom-right to top-left.
            for &(line, col) in positions.iter().rev() {
                if line != prev_line {
                    col_shift = 0;
                    prev_line = line;
                }
                let actual_col = col.min(self.lines[line].len()).saturating_sub(col_shift);
                if actual_col > 0 {
                    self.lines[line].remove(actual_col - 1);
                    new_positions.push((line, actual_col - 1));
                    col_shift += 1;
                } else {
                    new_positions.push((line, 0));
                }
            }
            new_positions.reverse();
            self.cursor = new_positions.pop().unwrap_or(self.cursor);
            self.extra_cursors = new_positions;
            self.preferred_col = None;
            self.dirty = true;
            if let Some(query) = self.search_query.clone() {
                self.set_search_query(query);
            }
            self.ensure_visible();
            return;
        }
        // Slow path: some cursors at col 0 need cross-line join.
        self.begin_edit();
        let mut chars: Vec<char> = self.document_text().chars().collect();
        let mut offsets: Vec<usize> = positions
            .into_iter()
            .filter_map(|pos| {
                let off = self.position_to_offset(pos);
                (off > 0).then_some(off)
            })
            .collect();
        offsets.sort_unstable();
        offsets.dedup();
        for off in offsets.iter().rev() {
            chars.remove(*off - 1);
        }
        self.set_document_text(chars.into_iter().collect());
        let mut new_positions: Vec<(usize, usize)> = offsets
            .into_iter()
            .map(|off| Self::offset_to_position(&self.lines, off.saturating_sub(1)))
            .collect();
        self.cursor = new_positions.pop().unwrap_or(self.cursor);
        self.extra_cursors = new_positions;
        self.preferred_col = None;
        self.dirty = true;
        if let Some(query) = self.search_query.clone() {
            self.set_search_query(query);
        }
        self.ensure_visible();
    }

    fn delete_forward_multi(&mut self) {
        let positions = self.sorted_cursor_positions();
        // Fast path: all cursors are within their line (no cross-line join).
        let all_within_line = positions
            .iter()
            .all(|&(line, col)| col < self.lines[line].len());
        if all_within_line {
            self.begin_edit();
            let mut new_positions = Vec::with_capacity(positions.len());
            let mut prev_line = usize::MAX;
            let mut col_shift: usize = 0;
            // Process from bottom-right to top-left.
            for &(line, col) in positions.iter().rev() {
                if line != prev_line {
                    col_shift = 0;
                    prev_line = line;
                }
                let actual_col = col.saturating_sub(col_shift);
                if actual_col < self.lines[line].len() {
                    self.lines[line].remove(actual_col);
                    col_shift += 1;
                }
                new_positions.push((line, actual_col));
            }
            new_positions.reverse();
            self.cursor = new_positions.pop().unwrap_or(self.cursor);
            self.extra_cursors = new_positions;
            self.preferred_col = None;
            self.dirty = true;
            if let Some(query) = self.search_query.clone() {
                self.set_search_query(query);
            }
            self.ensure_visible();
            return;
        }
        // Slow path: some cursors at end-of-line need cross-line join.
        self.begin_edit();
        let mut chars: Vec<char> = self.document_text().chars().collect();
        let total_len = chars.len();
        let mut offsets: Vec<usize> = positions
            .iter()
            .map(|&pos| self.position_to_offset(pos))
            .filter(|&off| off < total_len)
            .collect();
        offsets.sort_unstable();
        offsets.dedup();
        if offsets.is_empty() {
            self.undo_stack.pop();
            return;
        }
        for off in offsets.iter().rev() {
            chars.remove(*off);
        }
        self.set_document_text(chars.into_iter().collect());
        let mut new_positions: Vec<(usize, usize)> = offsets
            .into_iter()
            .map(|off| Self::offset_to_position(&self.lines, off))
            .collect();
        self.cursor = new_positions.pop().unwrap_or(self.cursor);
        self.extra_cursors = new_positions;
        self.preferred_col = None;
        self.dirty = true;
        if let Some(query) = self.search_query.clone() {
            self.set_search_query(query);
        }
        self.ensure_visible();
    }

    fn set_search_query(&mut self, query: String) {
        if query.is_empty() {
            self.search_query = None;
            self.search_matches.clear();
            self.active_match = 0;
            return;
        }

        let q = query.to_lowercase();
        self.search_query = Some(query);
        let q_len = q.len();
        let mut matches = Vec::new();
        for (line_idx, line) in self.lines.iter().enumerate() {
            let lower = line.to_lowercase();
            for (start, _) in lower.match_indices(&q) {
                matches.push(SearchMatch {
                    line: line_idx,
                    start,
                    end: start + q_len,
                });
            }
        }
        self.search_matches = matches;
        self.active_match = 0;
        if !self.search_matches.is_empty() {
            self.goto_search_match(0);
        }
    }

    fn goto_search_match(&mut self, idx: usize) {
        let Some(m) = self.search_matches.get(idx).copied() else {
            return;
        };
        self.cursor = (m.line, m.start);
        self.preferred_col = None;
        self.selection = Some(Selection {
            anchor: (m.line, m.start),
            cursor: (m.line, m.end),
        });
        self.center_cursor();
    }

    fn move_up_wrapped(&mut self) -> bool {
        if self.viewport_width == 0 {
            return false;
        }
        let width = self.viewport_width;
        let current_chunk = self.cursor.1 / width;
        let dx = self.cursor.1 % width;
        if current_chunk > 0 {
            let new_chunk = current_chunk - 1;
            let start = new_chunk * width;
            self.cursor.1 = (start + dx).min(self.current_line_len());
            self.preferred_col = Some(dx);
            self.ensure_visible();
            return true;
        }
        if self.cursor.0 == 0 {
            return false;
        }
        self.cursor.0 -= 1;
        let prev_len = self.current_line_len();
        let prev_chunks = prev_len.max(1).div_ceil(width);
        let start = (prev_chunks - 1) * width;
        self.cursor.1 = (start + dx).min(prev_len);
        self.preferred_col = Some(dx);
        self.ensure_visible();
        true
    }

    fn move_down_wrapped(&mut self) -> bool {
        if self.viewport_width == 0 {
            return false;
        }
        let width = self.viewport_width;
        let current_chunk = self.cursor.1 / width;
        let dx = self.cursor.1 % width;
        let current_len = self.current_line_len();
        let current_chunks = current_len.max(1).div_ceil(width);
        if current_chunk + 1 < current_chunks {
            let start = (current_chunk + 1) * width;
            self.cursor.1 = (start + dx).min(current_len);
            self.preferred_col = Some(dx);
            self.ensure_visible();
            return true;
        }
        if self.cursor.0 >= self.lines.len().saturating_sub(1) {
            return false;
        }
        self.cursor.0 += 1;
        let next_len = self.current_line_len();
        self.cursor.1 = dx.min(next_len);
        self.preferred_col = Some(dx);
        self.ensure_visible();
        true
    }

    fn search_match_at(&self, line: usize, col: usize) -> Option<(bool, SearchMatch)> {
        // Binary search to find the first match on this line (matches are sorted by line)
        let start_idx = self.search_matches.partition_point(|m| m.line < line);
        for idx in start_idx..self.search_matches.len() {
            let m = &self.search_matches[idx];
            if m.line > line {
                break;
            }
            if col >= m.start && col < m.end {
                return Some((idx == self.active_match, *m));
            }
        }
        None
    }

    fn char_selected(&self, line: usize, col: usize) -> bool {
        let Some((start, end)) = self.selection_bounds() else {
            return false;
        };
        (line, col) >= start && (line, col) < end
    }

    pub fn render(&mut self, frame: &mut Frame, area: Rect, is_focused: bool, theme: &Theme) {
        self.ensure_invariants();
        let filename = self.path.rsplit('/').next().unwrap_or(&self.path);
        let dirty_marker = if self.dirty { " ●" } else { "" };
        let ai_indicator = if self.ai_working { " ⟳ AI" } else { "" };
        let title = format!(
            " {}{}{} — {}/{} ",
            filename,
            dirty_marker,
            ai_indicator,
            self.cursor.0 + 1,
            self.lines.len()
        );

        let block = if is_focused {
            Block::default()
                .borders(Borders::TOP)
                .border_style(Style::default().fg(theme.text))
                .title(Span::styled(
                    title,
                    Style::default()
                        .fg(Color::White)
                        .bg(theme.text)
                        .add_modifier(Modifier::BOLD),
                ))
        } else {
            Block::default()
                .borders(Borders::TOP)
                .border_style(Style::default().fg(theme.border))
                .title(Span::styled(
                    title,
                    Style::default()
                        .fg(theme.text_muted)
                        .add_modifier(Modifier::BOLD),
                ))
        };

        let inner = block.inner(area);
        self.last_inner = Some(inner);
        frame.render_widget(block, area);

        if inner.height == 0 || inner.width == 0 {
            return;
        }

        self.viewport_height = inner.height as usize;
        let gutter_w = format!("{}", self.lines.len()).len() as u16 + 3;
        self.last_gutter_w = gutter_w;
        let content_w = inner.width.saturating_sub(gutter_w) as usize;
        self.viewport_width = content_w;
        self.clamp_scroll();
        if content_w == 0 {
            return;
        }

        let visible = self.usable_viewport_height();
        let start = self.scroll;
        let end = (start + visible).min(self.lines.len());
        let hl_spans = highlight::highlight_range(&self.lines, start, end, self.lang);

        let selection_bg = Color::DarkGray;
        let cached_selection = self.selection_bounds();
        let search_bg = theme.amber;
        let active_search_bg = theme.blue;
        let total_rows = visible as u16;
        let mut row_y: u16 = 0;
        let mut line_idx = start;

        while line_idx < self.lines.len() && row_y < total_rows {
            let i = line_idx - start;
            let is_cursor_line = line_idx == self.cursor.0;
            let line = &self.lines[line_idx];
            let base_fg = theme.text;
            let content_x = inner.x + gutter_w;
            let all_chars: Vec<char> = line.chars().collect();
            let total_chars = all_chars.len();
            let mut colours: Vec<Color> = vec![base_fg; total_chars];

            let byte_to_char: Vec<usize> = {
                let mut map = vec![0usize; line.len() + 1];
                let mut ci = 0usize;
                for (bi, _) in line.char_indices() {
                    map[bi] = ci;
                    ci += 1;
                }
                map[line.len()] = ci;
                map
            };

            if let Some(spans) = hl_spans.get(i) {
                for sp in spans {
                    let cs = byte_to_char.get(sp.start).copied().unwrap_or(0);
                    let ce = byte_to_char
                        .get(sp.end)
                        .copied()
                        .unwrap_or(total_chars)
                        .min(total_chars);
                    for ci in cs..ce {
                        colours[ci] = sp.color;
                    }
                }
            }

            let gutter_style = if is_cursor_line {
                Style::default().fg(theme.amber)
            } else {
                Style::default().fg(theme.text_muted)
            };

            let chunks = if self.wrap {
                total_chars.max(1).div_ceil(content_w)
            } else {
                1
            };

            for chunk_i in 0..chunks {
                if row_y >= total_rows {
                    break;
                }
                let y = inner.y + row_y;

                if chunk_i == 0 {
                    let gutter = format!(
                        "{:>width$} │ ",
                        line_idx + 1,
                        width = (gutter_w - 3) as usize
                    );
                    frame
                        .buffer_mut()
                        .set_string(inner.x, y, &gutter, gutter_style);
                } else {
                    let gutter = format!("{:>width$} ↪ ", "", width = (gutter_w - 3) as usize);
                    frame
                        .buffer_mut()
                        .set_string(inner.x, y, &gutter, gutter_style);
                }

                let (chunk_start, chunk_end) = if self.wrap {
                    let cs = chunk_i * content_w;
                    let ce = (cs + content_w).min(total_chars);
                    (cs, ce)
                } else {
                    let cs = self.scroll_x.min(total_chars);
                    let ce = (self.scroll_x + content_w).min(total_chars);
                    (cs, ce)
                };

                for ci in chunk_start..chunk_end {
                    let dx = (ci - chunk_start) as u16;
                    let sx = content_x + dx;
                    if sx >= inner.x + inner.width {
                        break;
                    }
                    let mut style = Style::default().fg(colours[ci]);
                    if cached_selection.is_some_and(|(s, e)| (line_idx, ci) >= s && (line_idx, ci) < e) {
                        style = style.bg(selection_bg).fg(Color::White);
                    } else if let Some((active, _)) = self.search_match_at(line_idx, ci) {
                        style = style.bg(if active { active_search_bg } else { search_bg });
                    }
                    frame
                        .buffer_mut()
                        .set_string(sx, y, &all_chars[ci].to_string(), style);
                }

                let rendered = chunk_end.saturating_sub(chunk_start);
                for cx in rendered..content_w {
                    let sx = content_x + cx as u16;
                    if sx >= inner.x + inner.width {
                        break;
                    }
                    frame.buffer_mut().set_string(sx, y, " ", Style::default());
                }

                for cursor_col in self
                    .extra_cursors
                    .iter()
                    .filter(|&&(cursor_line, _)| cursor_line == line_idx)
                    .map(|&(_, cursor_col)| cursor_col)
                    .chain(
                        (is_cursor_line && is_focused)
                            .then_some(self.cursor.1)
                            .into_iter(),
                    )
                {
                    if cursor_col >= chunk_start && cursor_col <= chunk_end {
                        let cursor_dx = cursor_col.saturating_sub(chunk_start) as u16;
                        let cursor_x =
                            content_x + cursor_dx.min(content_w.saturating_sub(1) as u16);
                        if cursor_x < inner.x + inner.width {
                            let cursor_char = all_chars.get(cursor_col).copied().unwrap_or(' ');
                            let style =
                                if cursor_col == self.cursor.1 && is_cursor_line && is_focused {
                                    Style::default().bg(Color::White).fg(Color::Black)
                                } else {
                                    Style::default().bg(theme.amber).fg(Color::Black)
                                };
                            frame.buffer_mut().set_string(
                                cursor_x,
                                y,
                                &cursor_char.to_string(),
                                style,
                            );
                        }
                    }
                }

                row_y += 1;
            }

            line_idx += 1;
        }

        // -----------------------------------------------------------------
        // Inline find/replace bar (2 lines at bottom of editor)
        // -----------------------------------------------------------------
        if self.replace_open {
            let bar_h = 2u16;
            let prompt_offset = if self.prompt_mode.is_some() || self.ai_status.is_some() { 1u16 } else { 0u16 };
            let bar_y = inner.y + inner.height.saturating_sub(bar_h + prompt_offset);
            let bar_w = inner.width;
            let bar_bg = Color::Rgb(30, 30, 30);

            // Line 1: Find field
            let find_focused = self.replace_field_focus == ReplaceField::Find;
            let find_label = " Find:    ";
            let find_buf_display = &self.replace_find_buf;
            let match_info = if self.search_matches.is_empty() {
                "No matches".to_string()
            } else {
                format!("{}/{}", self.active_match + 1, self.search_matches.len())
            };

            // Clear line 1
            for dx in 0..bar_w {
                frame.buffer_mut().set_string(
                    inner.x + dx, bar_y,
                    " ", Style::default().bg(bar_bg),
                );
            }
            // Draw find label
            frame.buffer_mut().set_string(
                inner.x, bar_y, find_label,
                Style::default().fg(theme.text_muted).bg(bar_bg),
            );
            // Draw find buffer
            let find_x = inner.x + find_label.len() as u16;
            let field_style = if find_focused {
                Style::default().fg(Color::White).bg(Color::Rgb(50, 50, 50))
            } else {
                Style::default().fg(theme.text).bg(bar_bg)
            };
            frame.buffer_mut().set_string(find_x, bar_y, find_buf_display, field_style);
            // Cursor on find field
            if find_focused {
                let cursor_x = find_x + find_buf_display.len() as u16;
                if cursor_x < inner.x + bar_w {
                    frame.buffer_mut().set_string(
                        cursor_x, bar_y, " ",
                        Style::default().bg(theme.amber).fg(Color::Black),
                    );
                }
            }
            // Match info right-aligned
            let info_x = (inner.x + bar_w).saturating_sub(match_info.len() as u16 + 1);
            frame.buffer_mut().set_string(
                info_x, bar_y, &match_info,
                Style::default().fg(theme.text_muted).bg(bar_bg),
            );

            // Line 2: Replace field
            let replace_focused = self.replace_field_focus == ReplaceField::Replace;
            let replace_label = " Replace: ";
            let replace_buf_display = &self.replace_replace_buf;
            let bar_y2 = bar_y + 1;

            // Clear line 2
            for dx in 0..bar_w {
                frame.buffer_mut().set_string(
                    inner.x + dx, bar_y2,
                    " ", Style::default().bg(bar_bg),
                );
            }
            frame.buffer_mut().set_string(
                inner.x, bar_y2, replace_label,
                Style::default().fg(theme.text_muted).bg(bar_bg),
            );
            let replace_x = inner.x + replace_label.len() as u16;
            let rfield_style = if replace_focused {
                Style::default().fg(Color::White).bg(Color::Rgb(50, 50, 50))
            } else {
                Style::default().fg(theme.text).bg(bar_bg)
            };
            frame.buffer_mut().set_string(replace_x, bar_y2, replace_buf_display, rfield_style);
            if replace_focused {
                let cursor_x = replace_x + replace_buf_display.len() as u16;
                if cursor_x < inner.x + bar_w {
                    frame.buffer_mut().set_string(
                        cursor_x, bar_y2, " ",
                        Style::default().bg(theme.amber).fg(Color::Black),
                    );
                }
            }

            // Action hints right-aligned on line 2
            let hints = "Enter next | Alt+Enter all | Esc close";
            let hints_x = (inner.x + bar_w).saturating_sub(hints.len() as u16 + 1);
            frame.buffer_mut().set_string(
                hints_x, bar_y2, hints,
                Style::default().fg(theme.text_muted).bg(bar_bg),
            );
        }

        if self.prompt_mode.is_some() || self.ai_status.is_some() {
            let bar_y = inner.y + inner.height.saturating_sub(1);
            if let Some(mode) = self.prompt_mode {
                let label = match mode {
                    PromptMode::Ai => "AI",
                    PromptMode::Search => "Search",
                    PromptMode::GotoLine => "Line",
                };
                let prompt_text = format!(" {}: {} ", label, self.prompt_input);
                let cursor_pos = inner.x + prompt_text.len() as u16;
                frame.buffer_mut().set_string(
                    inner.x,
                    bar_y,
                    &prompt_text,
                    Style::default().fg(theme.amber).bg(Color::Black),
                );
                let remaining = inner.width.saturating_sub(prompt_text.len() as u16);
                for dx in 0..remaining {
                    frame.buffer_mut().set_string(
                        inner.x + prompt_text.len() as u16 + dx,
                        bar_y,
                        " ",
                        Style::default().bg(Color::Black),
                    );
                }
                if cursor_pos < inner.x + inner.width {
                    frame.buffer_mut().set_string(
                        cursor_pos,
                        bar_y,
                        " ",
                        Style::default().bg(theme.amber).fg(Color::Black),
                    );
                }
            } else if let Some(ref status) = self.ai_status {
                let msg = format!(" {} ", status);
                frame.buffer_mut().set_string(
                    inner.x,
                    bar_y,
                    &msg,
                    Style::default().fg(Color::Black).bg(theme.green),
                );
                let remaining = inner.width.saturating_sub(msg.len() as u16);
                for dx in 0..remaining {
                    frame.buffer_mut().set_string(
                        inner.x + msg.len() as u16 + dx,
                        bar_y,
                        " ",
                        Style::default().bg(theme.green),
                    );
                }
            }
        }

        if self.lines.len() > visible {
            let mut scrollbar_state = ScrollbarState::new(self.lines.len()).position(self.scroll);
            frame.render_stateful_widget(
                Scrollbar::new(ScrollbarOrientation::VerticalRight),
                inner,
                &mut scrollbar_state,
            );
        }

        let max_line_len = self.lines[start..end]
            .iter()
            .map(|l| l.chars().count())
            .max()
            .unwrap_or(0);
        if !self.wrap && max_line_len > content_w {
            let hbar_area = Rect::new(
                inner.x + gutter_w,
                inner.y,
                inner.width.saturating_sub(gutter_w),
                inner.height,
            );
            let mut hbar_state = ScrollbarState::new(max_line_len).position(self.scroll_x);
            frame.render_stateful_widget(
                Scrollbar::new(ScrollbarOrientation::HorizontalBottom),
                hbar_area,
                &mut hbar_state,
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{Editor, OpenFileOutcome, PromptMode, SelectionRange, SelectionSet};
    use crate::highlight::Lang;

    fn editor_test_dir(name: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!(
            "fs-code-editor-{}-{}",
            name,
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn scroll_by_allows_overscroll_to_last_line() {
        // User-driven scrolls (mouse wheel, PgDn) overscroll the buffer:
        // the last line can be dragged all the way to the top of the
        // viewport, leaving empty rows below — same behaviour as VS Code,
        // Sublime, etc. So with 200 lines, max scroll is 199 (not 180).
        let mut editor = Editor::new();
        editor.lines = (0..200).map(|i| format!("line {i}")).collect();
        editor.viewport_height = 20;

        editor.scroll_by(500);

        assert_eq!(editor.scroll, 199);
        assert_eq!(editor.cursor.0, 199);
    }

    #[test]
    fn scroll_overscroll_works_when_lines_wrap() {
        // With wrap on, overscroll still lets the user reach the very
        // last logical line at the top of the viewport.
        let mut editor = Editor::new();
        editor.lines = (0..20).map(|_| "x".repeat(15)).collect();
        editor.viewport_height = 10;
        editor.viewport_width = 10;
        editor.wrap = true;

        editor.scroll_by(1000);

        assert_eq!(editor.scroll, 19);
    }

    #[test]
    fn cursor_move_clamps_scroll_to_real_content() {
        // Cursor-following scrolls (ensure_visible) still clamp to
        // max_scroll — the cursor never sits in the empty overscroll
        // region. Here viewport=10, footer=1 (Search prompt), usable=9,
        // so max_scroll is 30 - 9 = 21.
        let mut editor = Editor::new();
        editor.lines = (0..30).map(|i| format!("line {i}")).collect();
        editor.viewport_height = 10;
        editor.prompt_mode = Some(PromptMode::Search);
        editor.cursor = (29, 0);

        editor.ensure_visible();

        assert_eq!(editor.scroll, 21);
    }

    #[test]
    fn undo_and_redo_restore_content() {
        let mut editor = Editor::new();
        editor.lines = vec!["abc".into()];

        editor.insert_char('d');
        assert_eq!(editor.lines[0], "dabc");

        assert!(editor.undo());
        assert_eq!(editor.lines[0], "abc");

        assert!(editor.redo());
        assert_eq!(editor.lines[0], "dabc");
    }

    #[test]
    fn delete_selection_merges_lines() {
        let mut editor = Editor::new();
        editor.lines = vec!["hello".into(), "world".into()];
        editor.selection = Some(super::Selection {
            anchor: (0, 2),
            cursor: (1, 3),
        });

        editor.delete_char();

        assert_eq!(editor.lines, vec!["held".to_string()]);
        assert_eq!(editor.cursor, (0, 2));
    }

    #[test]
    fn search_tracks_matches() {
        let mut editor = Editor::new();
        editor.lines = vec!["alpha beta".into(), "beta gamma".into()];

        editor.set_search_query("beta".into());

        assert_eq!(editor.search_matches.len(), 2);
        assert_eq!(editor.cursor, (0, 6));
        assert!(editor.next_search_match());
        assert_eq!(editor.cursor, (1, 0));
    }

    #[test]
    fn open_search_prompt_prefills_word_under_cursor() {
        let mut editor = Editor::new();
        editor.lines = vec!["alpha beta".into()];
        editor.cursor = (0, 7);

        editor.open_search_prompt();

        assert_eq!(editor.prompt_input, "beta");
    }

    #[test]
    fn search_preview_prefers_match_near_cursor() {
        let mut editor = Editor::new();
        editor.lines = vec!["foo".into(), "bar".into(), "foo".into()];
        editor.cursor = (2, 1);
        editor.prompt_mode = Some(PromptMode::Search);
        editor.prompt_input = "foo".into();

        editor.preview_prompt();

        assert_eq!(editor.cursor, (2, 0));
        assert_eq!(editor.active_match, 1);
    }

    #[test]
    fn vertical_motion_preserves_preferred_column() {
        let mut editor = Editor::new();
        editor.lines = vec!["123456789".into(), "123".into(), "1234567".into()];
        editor.cursor = (0, 7);

        editor.move_down();
        assert_eq!(editor.cursor, (1, 3));

        editor.move_down();
        assert_eq!(editor.cursor, (2, 7));
    }

    #[test]
    fn move_lines_down_moves_current_line() {
        let mut editor = Editor::new();
        editor.lines = vec!["a".into(), "b".into(), "c".into()];
        editor.cursor = (0, 0);

        assert!(editor.move_lines_down());

        assert_eq!(editor.lines, vec!["b", "a", "c"]);
        assert_eq!(editor.cursor, (1, 0));
    }

    #[test]
    fn select_word_at_highlights_identifier() {
        let mut editor = Editor::new();
        editor.lines = vec!["hello world_1".into()];

        editor.select_word_at((0, 7));

        assert!(editor.selection_contains((0, 6)));
        assert!(editor.selection_contains((0, 12)));
        assert!(!editor.selection_contains((0, 5)));
    }

    #[test]
    fn move_selected_text_to_new_position() {
        let mut editor = Editor::new();
        editor.lines = vec!["hello world".into()];
        editor.selection = Some(super::Selection {
            anchor: (0, 6),
            cursor: (0, 11),
        });

        assert!(editor.move_selected_text_to((0, 0)));

        assert_eq!(editor.lines, vec!["worldhello ".to_string()]);
        assert!(editor.selection_contains((0, 1)));
    }

    #[test]
    fn shift_style_selection_extends_cursor_motion() {
        let mut editor = Editor::new();
        editor.lines = vec!["hello".into()];
        editor.cursor = (0, 1);

        editor.select_right();
        editor.select_right();

        assert!(editor.selection_contains((0, 1)));
        assert!(editor.selection_contains((0, 2)));
        assert_eq!(editor.cursor, (0, 3));
    }

    #[test]
    fn word_selection_extends_by_word_boundaries() {
        let mut editor = Editor::new();
        editor.lines = vec!["alpha beta_gamma".into()];
        editor.cursor = (0, 6);

        editor.select_word_right();

        assert!(editor.selection_contains((0, 6)));
        assert!(editor.selection_contains((0, 14)));
        assert_eq!(editor.cursor, (0, 16));
    }

    #[test]
    fn cut_selection_returns_text_and_removes_it() {
        let mut editor = Editor::new();
        editor.lines = vec!["hello world".into()];
        editor.selection = Some(super::Selection {
            anchor: (0, 0),
            cursor: (0, 5),
        });

        let cut = editor.cut_selection();

        assert_eq!(cut.as_deref(), Some("hello"));
        assert_eq!(editor.lines, vec![" world".to_string()]);
    }

    #[test]
    fn selection_set_merges_overlapping_ranges() {
        let set = SelectionSet::from_ranges(vec![
            SelectionRange::new((1, 2), (1, 6)),
            SelectionRange::new((0, 3), (0, 5)),
            SelectionRange::new((1, 4), (1, 8)),
        ]);

        let merged = set.normalized_ranges();

        assert_eq!(
            merged,
            vec![
                SelectionRange::new((0, 3), (0, 5)),
                SelectionRange::new((1, 2), (1, 8)),
            ]
        );
    }

    #[test]
    fn selected_texts_for_multi_selection_set() {
        let mut editor = Editor::new();
        editor.lines = vec!["hello world".into(), "rustacean".into()];
        let set = SelectionSet::from_ranges(vec![
            SelectionRange::new((0, 0), (0, 5)),
            SelectionRange::new((1, 0), (1, 4)),
        ]);

        assert_eq!(editor.selected_texts_for(&set), vec!["hello", "rust"]);
    }

    #[test]
    fn replace_selection_set_rewrites_multiple_ranges() {
        let mut editor = Editor::new();
        editor.lines = vec!["hello world".into()];
        let set = SelectionSet::from_ranges(vec![
            SelectionRange::new((0, 0), (0, 5)),
            SelectionRange::new((0, 6), (0, 11)),
        ]);

        let applied = editor.replace_selection_set(&set, &["hi".into(), "planet".into()]);

        assert_eq!(applied, 2);
        assert_eq!(editor.lines, vec!["hi planet".to_string()]);
    }

    #[test]
    fn replace_all_updates_matching_lines() {
        let mut editor = Editor::new();
        editor.lines = vec!["foo bar".into(), "foo baz".into()];

        let replaced = editor.replace_all("foo", "qux");

        assert_eq!(replaced, 2);
        assert_eq!(
            editor.lines,
            vec!["qux bar".to_string(), "qux baz".to_string()]
        );
    }

    #[test]
    fn multi_cursor_insert_text_applies_to_all_cursors() {
        let mut editor = Editor::new();
        editor.lines = vec!["abc".into(), "def".into()];
        editor.cursor = (0, 1);
        editor.add_cursor((1, 2));

        editor.insert_text("X");

        assert_eq!(editor.lines, vec!["aXbc".to_string(), "deXf".to_string()]);
        assert_eq!(editor.extra_cursors, vec![(0, 2)]);
        assert_eq!(editor.cursor, (1, 3));
    }

    #[test]
    fn multi_cursor_backspace_applies_to_all_cursors() {
        let mut editor = Editor::new();
        editor.lines = vec!["abcd".into(), "wxyz".into()];
        editor.cursor = (0, 2);
        editor.add_cursor((1, 3));

        editor.backspace();

        assert_eq!(editor.lines, vec!["acd".to_string(), "wxz".to_string()]);
    }

    #[test]
    fn add_next_occurrence_cursor_uses_selected_text() {
        let mut editor = Editor::new();
        editor.lines = vec!["foo bar foo".into()];
        editor.selection = Some(super::Selection {
            anchor: (0, 0),
            cursor: (0, 3),
        });
        editor.cursor = (0, 3);

        assert!(editor.add_next_occurrence_cursor());

        assert_eq!(editor.extra_cursors, vec![(0, 11)]);
    }

    #[test]
    fn add_next_occurrence_selects_word_under_cursor() {
        let mut editor = Editor::new();
        editor.lines = vec!["foo bar foo".into()];
        editor.cursor = (0, 1);

        assert!(editor.add_next_occurrence_cursor());

        assert!(editor.selection_contains((0, 1)));
        assert_eq!(editor.extra_cursors, vec![(0, 11)]);
    }

    #[test]
    fn add_prev_occurrence_selects_word_under_cursor() {
        let mut editor = Editor::new();
        editor.lines = vec!["foo bar foo".into()];
        editor.cursor = (0, 9);

        assert!(editor.add_prev_occurrence_cursor());

        assert!(editor.selection_contains((0, 9)));
        assert_eq!(editor.extra_cursors, vec![(0, 3)]);
    }

    #[test]
    fn add_vertical_cursors_tracks_same_columns() {
        let mut editor = Editor::new();
        editor.lines = vec!["abcd".into(), "xy".into(), "12345".into()];
        editor.cursor = (1, 2);

        assert_eq!(editor.add_cursor_above(), 1);
        assert_eq!(editor.add_cursor_below(), 1);
        assert_eq!(editor.extra_cursors, vec![(0, 2), (2, 2)]);
    }

    #[test]
    fn toggle_cursor_adds_and_removes_extra_cursor() {
        let mut editor = Editor::new();
        editor.lines = vec!["abcd".into()];
        editor.cursor = (0, 1);

        assert!(editor.toggle_cursor((0, 3)));
        assert_eq!(editor.extra_cursors, vec![(0, 3)]);

        assert!(editor.toggle_cursor((0, 3)));
        assert!(editor.extra_cursors.is_empty());
    }

    #[test]
    fn set_column_cursors_clamps_each_line() {
        let mut editor = Editor::new();
        editor.lines = vec!["abcd".into(), "x".into(), "12345".into()];

        let total = editor.set_column_cursors((0, 1), (2, 3));

        assert_eq!(total, 3);
        assert_eq!(editor.cursor, (2, 3));
        assert_eq!(editor.extra_cursors, vec![(0, 3), (1, 1)]);
    }

    #[test]
    fn multi_cursor_motion_moves_every_cursor() {
        let mut editor = Editor::new();
        editor.lines = vec!["abcd".into(), "wxyz".into()];
        editor.cursor = (0, 2);
        editor.add_cursor((1, 2));

        editor.move_right();

        assert_eq!(editor.cursor, (0, 3));
        assert_eq!(editor.extra_cursors, vec![(1, 3)]);

        editor.move_end();

        assert_eq!(editor.cursor, (0, 4));
        assert_eq!(editor.extra_cursors, vec![(1, 4)]);
    }

    #[test]
    fn replace_current_and_next_uses_saved_replacement() {
        let mut editor = Editor::new();
        editor.lines = vec!["foo foo".into()];
        editor.replace_all("foo", "bar");
        editor.lines = vec!["foo foo".into()];
        editor.set_search_query("foo".into());

        assert!(editor.replace_current_and_next());

        assert_eq!(editor.lines, vec!["bar foo".to_string()]);
    }

    #[test]
    fn replace_all_current_uses_saved_replacement() {
        let mut editor = Editor::new();
        editor.lines = vec!["foo foo".into(), "foo".into()];
        editor.replace_all("foo", "bar");
        editor.lines = vec!["foo foo".into(), "foo".into()];
        editor.set_search_query("foo".into());

        let replaced = editor.replace_all_current();

        assert_eq!(replaced, Some(3));
        assert_eq!(editor.lines, vec!["bar bar".to_string(), "bar".to_string()]);
    }

    #[test]
    fn select_current_line_selects_active_line() {
        let mut editor = Editor::new();
        editor.lines = vec!["alpha".into(), "beta".into()];
        editor.cursor = (1, 2);

        editor.select_current_line();

        assert!(editor.selection_contains((1, 0)));
        assert!(editor.selection_contains((1, 3)));
        assert!(!editor.selection_contains((0, 0)));
    }

    #[test]
    fn select_bottom_extends_selection_to_end_of_file() {
        let mut editor = Editor::new();
        editor.lines = vec!["alpha".into(), "beta".into(), "gamma".into()];
        editor.cursor = (0, 2);

        editor.select_bottom();

        assert!(editor.selection_contains((0, 2)));
        assert!(editor.selection_contains((1, 0)));
        assert_eq!(editor.cursor, (2, 0));
    }

    // -----------------------------------------------------------------------
    // Feature: Block (rectangular) selection
    // -----------------------------------------------------------------------

    #[test]
    fn block_selection_contains_checks_rectangle() {
        let bs = super::BlockSelection::new((1, 2), (3, 5));
        assert!(bs.contains(2, 3));
        assert!(!bs.contains(0, 3));
        assert!(!bs.contains(2, 5)); // exclusive end
        assert!(!bs.contains(2, 1));
    }

    #[test]
    fn block_selected_text_extracts_rectangle() {
        let mut editor = Editor::new();
        editor.lines = vec!["abcde".into(), "fghij".into(), "klmno".into()];
        editor.block_selection = Some(super::BlockSelection::new((0, 1), (2, 3)));

        let text = editor.block_selected_text().unwrap();
        assert_eq!(text, "bc\ngh\nlm");
    }

    #[test]
    fn delete_block_selection_removes_rectangle() {
        let mut editor = Editor::new();
        editor.lines = vec!["abcde".into(), "fghij".into()];
        editor.block_selection = Some(super::BlockSelection::new((0, 1), (1, 3)));

        editor.delete_block_selection();

        assert_eq!(editor.lines, vec!["ade".to_string(), "fij".to_string()]);
    }

    #[test]
    fn block_insert_char_inserts_on_all_lines() {
        let mut editor = Editor::new();
        editor.lines = vec!["abc".into(), "def".into()];
        editor.block_selection = Some(super::BlockSelection::new((0, 1), (1, 1)));

        editor.block_insert_char('X');

        assert_eq!(editor.lines, vec!["aXbc".to_string(), "dXef".to_string()]);
    }

    // -----------------------------------------------------------------------
    // Feature: Multi-cursor skip/remove
    // -----------------------------------------------------------------------

    #[test]
    fn skip_current_occurrence_removes_and_adds_next() {
        let mut editor = Editor::new();
        editor.lines = vec!["foo bar foo baz foo".into()];
        editor.cursor = (0, 0);

        // Add first occurrence cursor
        assert!(editor.add_next_occurrence_cursor());
        let initial_count = editor.extra_cursors.len();

        // Skip: removes last added, adds next
        let result = editor.skip_current_occurrence();
        assert!(result.is_some());
        // Should still have same number of extra cursors
        assert_eq!(editor.extra_cursors.len(), initial_count);
    }

    #[test]
    fn remove_last_cursor_pops_extra() {
        let mut editor = Editor::new();
        editor.lines = vec!["abc".into()];
        editor.cursor = (0, 0);
        editor.add_cursor((0, 2));

        assert!(editor.remove_last_cursor());
        assert!(editor.extra_cursors.is_empty());
        assert!(!editor.remove_last_cursor());
    }

    // -----------------------------------------------------------------------
    // Feature: Code folding
    // -----------------------------------------------------------------------

    #[test]
    fn fold_range_detects_indented_block() {
        let mut editor = Editor::new();
        editor.lines = vec![
            "fn foo() {".into(),
            "    let x = 1;".into(),
            "    let y = 2;".into(),
            "}".into(),
        ];

        let range = editor.fold_range(0);
        assert_eq!(range, Some((0, 2)));
    }

    #[test]
    fn fold_range_returns_none_for_flat_code() {
        let mut editor = Editor::new();
        editor.lines = vec!["a".into(), "b".into(), "c".into()];

        assert_eq!(editor.fold_range(0), None);
    }

    #[test]
    fn toggle_fold_adds_and_removes() {
        let mut editor = Editor::new();
        editor.lines = vec![
            "fn foo() {".into(),
            "    body".into(),
            "}".into(),
        ];

        editor.toggle_fold(0);
        assert!(editor.is_folded(0));
        assert!(!editor.is_line_visible(1));

        editor.toggle_fold(0);
        assert!(!editor.is_folded(0));
        assert!(editor.is_line_visible(1));
    }

    #[test]
    fn fold_all_and_unfold_all() {
        let mut editor = Editor::new();
        editor.lines = vec![
            "fn a() {".into(),
            "    body_a".into(),
            "}".into(),
            "fn b() {".into(),
            "    body_b".into(),
            "}".into(),
        ];

        editor.fold_all();
        assert!(editor.is_folded(0));
        assert!(editor.is_folded(3));

        editor.unfold_all();
        assert!(!editor.is_folded(0));
        assert!(!editor.is_folded(3));
    }

    // -----------------------------------------------------------------------
    // Feature: Diagnostics
    // -----------------------------------------------------------------------

    #[test]
    fn set_and_navigate_diagnostics() {
        let mut editor = Editor::new();
        editor.lines = vec!["line0".into(), "line1".into(), "line2".into()];

        editor.set_diagnostics(vec![
            super::Diagnostic {
                line: 0, col_start: 0, col_end: 5,
                severity: super::DiagnosticSeverity::Error,
                message: "err".into(),
            },
            super::Diagnostic {
                line: 2, col_start: 0, col_end: 5,
                severity: super::DiagnosticSeverity::Warning,
                message: "warn".into(),
            },
        ]);

        assert!(editor.next_diagnostic());
        assert_eq!(editor.cursor.0, 0);

        assert!(editor.next_diagnostic());
        assert_eq!(editor.cursor.0, 2);

        assert!(editor.prev_diagnostic());
        assert_eq!(editor.cursor.0, 0);
    }

    #[test]
    fn toggle_diagnostics_visibility() {
        let mut editor = Editor::new();
        assert!(editor.show_diagnostics);
        editor.toggle_diagnostics();
        assert!(!editor.show_diagnostics);
        editor.toggle_diagnostics();
        assert!(editor.show_diagnostics);
    }

    // -----------------------------------------------------------------------
    // Feature: Symbol outline
    // -----------------------------------------------------------------------

    #[test]
    fn extract_symbols_finds_rust_items() {
        let mut editor = Editor::new();
        editor.lang = Lang::Rust;
        editor.lines = vec![
            "pub fn hello() {}".into(),
            "struct Foo;".into(),
            "impl Foo {".into(),
            "    fn bar() {}".into(),
            "}".into(),
        ];

        let symbols = editor.extract_symbols();
        assert!(symbols.len() >= 3);
        assert_eq!(symbols[0].name, "hello");
        assert_eq!(symbols[1].name, "Foo");
    }

    #[test]
    fn outline_filter_narrows_symbols() {
        let mut editor = Editor::new();
        editor.lang = Lang::Rust;
        editor.lines = vec![
            "fn alpha() {}".into(),
            "fn beta() {}".into(),
            "struct Gamma;".into(),
        ];

        editor.open_outline();
        assert_eq!(editor.filtered_outline().len(), 3);

        editor.outline_char('b');
        assert_eq!(editor.filtered_outline().len(), 1);
        assert_eq!(editor.filtered_outline()[0].name, "beta");
    }

    // -----------------------------------------------------------------------
    // Feature: Tab management
    // -----------------------------------------------------------------------

    #[test]
    fn open_file_keeps_loaded_content_visible() {
        let root = editor_test_dir("open-visible");
        let file = root.join("visible.txt");
        std::fs::write(&file, "alpha\nbeta\n").unwrap();

        let mut editor = Editor::new();
        let outcome = editor.open_file(file.to_str().unwrap()).unwrap();

        assert_eq!(outcome, OpenFileOutcome::Opened);
        assert_eq!(editor.lines, vec!["alpha".to_string(), "beta".to_string()]);
        assert_eq!(editor.tab_count(), 1);

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn opening_existing_clean_tab_reloads_disk_content() {
        let root = editor_test_dir("open-reload-clean");
        let file = root.join("reload.txt");
        std::fs::write(&file, "old\n").unwrap();

        let mut editor = Editor::new();
        editor.open_file(file.to_str().unwrap()).unwrap();
        assert_eq!(editor.lines, vec!["old".to_string()]);

        std::fs::write(&file, "new\n").unwrap();
        let outcome = editor.open_file(file.to_str().unwrap()).unwrap();

        assert_eq!(outcome, OpenFileOutcome::Reloaded);
        assert_eq!(editor.lines, vec!["new".to_string()]);
        assert!(!editor.dirty);

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn opening_existing_dirty_tab_without_disk_change_reports_preserved_dirty() {
        let root = editor_test_dir("open-preserve-dirty-unchanged");
        let file = root.join("dirty-unchanged.txt");
        std::fs::write(&file, "local\n").unwrap();

        let mut editor = Editor::new();
        editor.open_file(file.to_str().unwrap()).unwrap();
        editor.insert_char('X');

        let outcome = editor.open_file(file.to_str().unwrap()).unwrap();

        assert_eq!(outcome, OpenFileOutcome::PreservedDirty);
        assert_eq!(editor.lines, vec!["Xlocal".to_string()]);
        assert!(editor.dirty);

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn opening_existing_dirty_tab_with_disk_change_reports_conflict() {
        let root = editor_test_dir("open-preserve-dirty");
        let file = root.join("dirty.txt");
        std::fs::write(&file, "local\n").unwrap();

        let mut editor = Editor::new();
        editor.open_file(file.to_str().unwrap()).unwrap();
        editor.insert_char('X');
        assert_eq!(editor.lines, vec!["Xlocal".to_string()]);
        assert!(editor.dirty);

        std::fs::write(&file, "external\n").unwrap();
        let outcome = editor.open_file(file.to_str().unwrap()).unwrap();

        assert_eq!(outcome, OpenFileOutcome::PreservedDirtyWithDiskChanges);
        assert_eq!(editor.lines, vec!["Xlocal".to_string()]);
        assert!(editor.dirty);

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn tab_switching_preserves_file_contents_after_open_file() {
        let root = editor_test_dir("switch-preserves-content");
        let a = root.join("a.txt");
        let b = root.join("b.txt");
        std::fs::write(&a, "file_a\n").unwrap();
        std::fs::write(&b, "file_b\n").unwrap();

        let mut editor = Editor::new();
        editor.open_file(a.to_str().unwrap()).unwrap();
        editor.open_file(b.to_str().unwrap()).unwrap();

        editor.switch_tab(0);
        assert_eq!(editor.path, a.to_string_lossy().to_string());
        assert_eq!(editor.lines, vec!["file_a".to_string()]);

        editor.switch_tab(1);
        assert_eq!(editor.path, b.to_string_lossy().to_string());
        assert_eq!(editor.lines, vec!["file_b".to_string()]);

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn tab_management_tracks_open_files() {
        let mut editor = Editor::new();

        // Simulate opening two files without filesystem
        editor.path = "a.rs".to_string();
        editor.lines = vec!["file_a".into()];
        editor.open = true;
        editor.lang = Lang::Rust;
        editor.save_current_tab();
        assert_eq!(editor.tab_count(), 1);

        // "Open" second file
        editor.path = "b.rs".to_string();
        editor.lines = vec!["file_b".into()];
        editor.lang = Lang::Rust;
        editor.save_current_tab();
        assert_eq!(editor.tab_count(), 2);

        // Switch back
        editor.switch_tab(0);
        assert_eq!(editor.path, "a.rs");
        assert_eq!(editor.lines, vec!["file_a".to_string()]);

        // Close active tab
        let closed = editor.close_tab();
        assert!(!closed);
        assert_eq!(editor.tab_count(), 1);
        assert_eq!(editor.path, "b.rs");
    }

    #[test]
    fn next_prev_tab_cycles() {
        let mut editor = Editor::new();

        editor.path = "a.rs".to_string();
        editor.lines = vec!["a".into()];
        editor.open = true;
        editor.save_current_tab();

        editor.path = "b.rs".to_string();
        editor.lines = vec!["b".into()];
        editor.save_current_tab();

        editor.path = "c.rs".to_string();
        editor.lines = vec!["c".into()];
        editor.save_current_tab();

        assert_eq!(editor.active_tab, 2);
        editor.next_tab();
        assert_eq!(editor.active_tab, 0);
        editor.prev_tab();
        assert_eq!(editor.active_tab, 2);
    }

    // -----------------------------------------------------------------------
    // Feature: Inline find/replace bar
    // -----------------------------------------------------------------------

    #[test]
    fn replace_bar_finds_and_replaces() {
        let mut editor = Editor::new();
        editor.lines = vec!["foo bar foo".into()];
        editor.cursor = (0, 5); // on "bar" so seed won't be "foo"

        editor.open_replace_bar();
        // Clear the seeded find buf first
        while !editor.replace_find_buf.is_empty() {
            editor.replace_backspace();
        }
        for c in "foo".chars() {
            editor.replace_char(c);
        }
        assert!(!editor.search_matches.is_empty());

        editor.replace_toggle_field();
        for c in "baz".chars() {
            editor.replace_char(c);
        }

        let count = editor.replace_bar_all();
        assert_eq!(count, 2);
        assert_eq!(editor.lines, vec!["baz bar baz".to_string()]);
    }

    // -----------------------------------------------------------------------
    // Feature: Clipboard / copy line with no selection
    // -----------------------------------------------------------------------

    #[test]
    fn lines_ref_provides_read_access() {
        let mut editor = Editor::new();
        editor.lines = vec!["hello".into(), "world".into()];

        let lines = editor.lines_ref();
        assert_eq!(lines[0], "hello");
        assert_eq!(lines[1], "world");
    }
}
