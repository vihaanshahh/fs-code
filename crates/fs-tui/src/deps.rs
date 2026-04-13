//! Dependency viewer — shows what a file imports and what imports it.
//!
//! Triggered with Ctrl+I on the selected sidebar file or the open editor file.
//! Parses import/require/use statements from file content, resolves relative
//! paths against the filesystem (green = found, red = broken), and greps the
//! project for reverse dependencies.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Command;

use ratatui::prelude::*;
use ratatui::widgets::{
    Block, Borders, Clear, List, ListItem, Paragraph, Scrollbar,
    ScrollbarOrientation, ScrollbarState,
};

use crate::theme::Theme;

// ---------------------------------------------------------------------------
// Import entry
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub enum ImportKind {
    /// Relative path (starts with ./ or ../)
    Relative,
    /// Node module / external package
    External,
    /// Rust use/mod declaration
    RustDecl,
}

#[derive(Debug, Clone)]
pub struct ImportEntry {
    pub raw: String,
    pub kind: ImportKind,
    /// Resolved absolute path (for relative imports that exist on disk)
    pub resolved: Option<String>,
}

impl ImportEntry {
    fn is_broken(&self) -> bool {
        self.kind == ImportKind::Relative && self.resolved.is_none()
    }
}

// ---------------------------------------------------------------------------
// DepsViewer state
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq)]
enum Section {
    Imports,
    ImportedBy,
}

pub struct DepsViewer {
    pub file_path: String,
    pub imports: Vec<ImportEntry>,
    pub imported_by: Vec<String>,
    open: bool,
    scroll_imports: usize,
    scroll_imported_by: usize,
    section: Section,
}

impl DepsViewer {
    pub fn new() -> Self {
        Self {
            file_path: String::new(),
            imports: Vec::new(),
            imported_by: Vec::new(),
            open: false,
            scroll_imports: 0,
            scroll_imported_by: 0,
            section: Section::Imports,
        }
    }

    /// Load deps for `file_path`, searching for importers within `cwd`.
    pub fn open_for(&mut self, file_path: &str, cwd: &str) {
        self.file_path = file_path.to_string();
        self.scroll_imports = 0;
        self.scroll_imported_by = 0;
        self.section = Section::Imports;

        let content = std::fs::read_to_string(file_path).unwrap_or_default();
        let ext = Path::new(file_path)
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        let dir = Path::new(file_path).parent().unwrap_or(Path::new("."));

        self.imports = parse_imports(&content, &ext, dir);
        self.imported_by = find_importers(file_path, cwd);
        self.open = true;
    }

    pub fn close(&mut self) {
        self.open = false;
    }

    pub fn scroll_up(&mut self, n: usize) {
        match self.section {
            Section::Imports => {
                self.scroll_imports = self.scroll_imports.saturating_sub(n);
            }
            Section::ImportedBy => {
                self.scroll_imported_by = self.scroll_imported_by.saturating_sub(n);
            }
        }
    }

    pub fn scroll_down(&mut self, n: usize) {
        match self.section {
            Section::Imports => self.scroll_imports += n,
            Section::ImportedBy => self.scroll_imported_by += n,
        }
    }

    /// Switch to the imports section.
    pub fn focus_imports(&mut self) {
        self.section = Section::Imports;
    }

    /// Switch to the imported-by section.
    pub fn focus_imported_by(&mut self) {
        self.section = Section::ImportedBy;
    }

    pub fn toggle_section(&mut self) {
        self.section = match self.section {
            Section::Imports => Section::ImportedBy,
            Section::ImportedBy => Section::Imports,
        };
    }

    pub fn broken_count(&self) -> usize {
        self.imports.iter().filter(|e| e.is_broken()).count()
    }

    // -----------------------------------------------------------------------
    // Rendering
    // -----------------------------------------------------------------------

    pub fn render(&self, frame: &mut Frame, area: Rect, theme: &Theme) {
        // Centered overlay: 80% width, 80% height
        let w = (area.width * 4 / 5).max(40).min(area.width);
        let h = (area.height * 4 / 5).max(10).min(area.height);
        let x = area.x + (area.width.saturating_sub(w)) / 2;
        let y = area.y + (area.height.saturating_sub(h)) / 2;
        let overlay_area = Rect::new(x, y, w, h);

        frame.render_widget(Clear, overlay_area);

        let file_name = Path::new(&self.file_path)
            .file_name()
            .map(|f| f.to_string_lossy().to_string())
            .unwrap_or_else(|| self.file_path.clone());

        let broken = self.broken_count();
        let title = if broken > 0 {
            format!(" Deps: {}  {} broken import{} ", file_name, broken,
                if broken == 1 { "" } else { "s" })
        } else {
            format!(" Deps: {} ", file_name)
        };

        let title_style = Style::default()
            .fg(if broken > 0 { theme.red } else { theme.accent })
            .add_modifier(Modifier::BOLD);

        let block = Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(theme.border))
            .title(Span::styled(title, title_style))
            .title_bottom(Span::styled(
                " Tab switch section │ j/k scroll │ Esc close ",
                Style::default().fg(theme.text_muted),
            ));

        let inner = block.inner(overlay_area);
        frame.render_widget(block, overlay_area);

        if inner.height < 4 {
            return;
        }

        // Split vertically: imports top half, imported-by bottom half
        let half = (inner.height / 2).max(2);
        let imports_area = Rect::new(inner.x, inner.y, inner.width, half);
        let imported_by_area = Rect::new(
            inner.x,
            inner.y + half,
            inner.width,
            inner.height - half,
        );

        self.render_imports_section(frame, imports_area, theme);
        self.render_imported_by_section(frame, imported_by_area, theme);
    }

    fn render_imports_section(&self, frame: &mut Frame, area: Rect, theme: &Theme) {
        let is_active = self.section == Section::Imports;
        let header_style = if is_active {
            Style::default().fg(theme.accent).add_modifier(Modifier::BOLD | Modifier::UNDERLINED)
        } else {
            Style::default().fg(theme.text_muted)
        };

        let broken = self.imports.iter().filter(|e| e.is_broken()).count();
        let header = format!(
            "Imports ({}){}",
            self.imports.len(),
            if broken > 0 { format!("  {} broken", broken) } else { String::new() }
        );

        let section_block = Block::default()
            .borders(Borders::BOTTOM)
            .border_style(Style::default().fg(theme.border))
            .title(Span::styled(header, header_style));

        let inner = section_block.inner(area);
        frame.render_widget(section_block, area);

        if self.imports.is_empty() {
            frame.render_widget(
                Paragraph::new("  (no imports detected)")
                    .style(Style::default().fg(theme.text_muted)),
                inner,
            );
            return;
        }

        let visible = inner.height as usize;
        let max_scroll = self.imports.len().saturating_sub(1);
        let scroll = self.scroll_imports.min(max_scroll);

        let items: Vec<ListItem> = self
            .imports
            .iter()
            .skip(scroll)
            .take(visible)
            .map(|entry| {
                let (icon, fg) = match entry.kind {
                    ImportKind::External => ("  ", theme.text_muted),
                    ImportKind::Relative if entry.resolved.is_some() => ("✓ ", theme.green),
                    ImportKind::Relative => ("✗ ", theme.red),
                    ImportKind::RustDecl => ("  ", theme.blue),
                };

                let label = format!("{}{}", icon, entry.raw);
                let truncated: String = label.chars().take(inner.width as usize).collect();
                ListItem::new(Line::from(Span::styled(
                    truncated,
                    Style::default().fg(fg),
                )))
            })
            .collect();

        frame.render_widget(
            List::new(items).style(Style::default().bg(theme.bg)),
            inner,
        );

        if self.imports.len() > visible {
            let mut state = ScrollbarState::new(self.imports.len()).position(scroll);
            frame.render_stateful_widget(
                Scrollbar::new(ScrollbarOrientation::VerticalRight),
                inner,
                &mut state,
            );
        }
    }

    fn render_imported_by_section(&self, frame: &mut Frame, area: Rect, theme: &Theme) {
        let is_active = self.section == Section::ImportedBy;
        let header_style = if is_active {
            Style::default().fg(theme.accent).add_modifier(Modifier::BOLD | Modifier::UNDERLINED)
        } else {
            Style::default().fg(theme.text_muted)
        };

        let header = format!("Imported by ({})", self.imported_by.len());
        let section_block = Block::default()
            .borders(Borders::NONE)
            .title(Span::styled(header, header_style));

        let inner = section_block.inner(area);
        frame.render_widget(section_block, area);

        if self.imported_by.is_empty() {
            frame.render_widget(
                Paragraph::new("  (nothing imports this file)")
                    .style(Style::default().fg(theme.text_muted)),
                inner,
            );
            return;
        }

        let visible = inner.height as usize;
        let max_scroll = self.imported_by.len().saturating_sub(1);
        let scroll = self.scroll_imported_by.min(max_scroll);

        let items: Vec<ListItem> = self
            .imported_by
            .iter()
            .skip(scroll)
            .take(visible)
            .map(|path| {
                let label = format!("  {}", path);
                let truncated: String = label.chars().take(inner.width as usize).collect();
                ListItem::new(Line::from(Span::styled(
                    truncated,
                    Style::default().fg(theme.text),
                )))
            })
            .collect();

        frame.render_widget(
            List::new(items).style(Style::default().bg(theme.bg)),
            inner,
        );

        if self.imported_by.len() > visible {
            let mut state =
                ScrollbarState::new(self.imported_by.len()).position(scroll);
            frame.render_stateful_widget(
                Scrollbar::new(ScrollbarOrientation::VerticalRight),
                inner,
                &mut state,
            );
        }
    }
}

// ---------------------------------------------------------------------------
// Import parsing
// ---------------------------------------------------------------------------

fn extract_quoted(s: &str) -> Option<String> {
    let s = s.trim();
    let delim = s.chars().next()?;
    if delim != '\'' && delim != '"' && delim != '`' {
        return None;
    }
    let inner = &s[1..];
    let end = inner.find(delim)?;
    Some(inner[..end].to_string())
}

fn parse_imports(content: &str, ext: &str, from_dir: &Path) -> Vec<ImportEntry> {
    match ext {
        "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" => {
            parse_js_imports(content, from_dir)
        }
        "py" => parse_python_imports(content),
        "rs" => parse_rust_imports(content),
        _ => Vec::new(),
    }
}

fn parse_js_imports(content: &str, from_dir: &Path) -> Vec<ImportEntry> {
    let mut entries = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    for line in content.lines() {
        let t = line.trim();

        // ES: import ... from 'path'  /  export ... from 'path'
        // Side-effect: import 'path'
        // CommonJS: require('path')
        let raw_opt: Option<String> = if let Some(pos) = t.rfind(" from ") {
            extract_quoted(t[pos + 6..].trim())
        } else if t.starts_with("import ") && !t.contains(" from ") {
            extract_quoted(t[7..].trim())
        } else if let Some(pos) = t.find("require(") {
            extract_quoted(t[pos + 8..].trim())
        } else {
            None
        };

        let raw = match raw_opt {
            Some(r) => r,
            None => continue,
        };
        if raw.is_empty() || seen.contains(&raw) {
            continue;
        }
        seen.insert(raw.clone());

        let kind = if raw.starts_with('.') {
            ImportKind::Relative
        } else {
            ImportKind::External
        };

        let resolved = if kind == ImportKind::Relative {
            resolve_js_path(from_dir, &raw)
        } else {
            None
        };

        entries.push(ImportEntry { raw, kind, resolved });
    }

    entries
}

fn resolve_js_path(from_dir: &Path, import_path: &str) -> Option<String> {
    let base = from_dir.join(import_path);

    // Exact file
    if base.is_file() {
        return Some(base.to_string_lossy().to_string());
    }

    // Try common extensions
    for ext in &["ts", "tsx", "js", "jsx", "mjs", "d.ts"] {
        let candidate =
            PathBuf::from(format!("{}.{}", base.to_string_lossy(), ext));
        if candidate.is_file() {
            return Some(candidate.to_string_lossy().to_string());
        }
    }

    // Directory index files
    for index in &["index.ts", "index.tsx", "index.js", "index.jsx"] {
        let candidate = base.join(index);
        if candidate.is_file() {
            return Some(candidate.to_string_lossy().to_string());
        }
    }

    None
}

fn parse_python_imports(content: &str) -> Vec<ImportEntry> {
    let mut entries = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    for line in content.lines() {
        let t = line.trim();

        let raw = if t.starts_with("from ") {
            t.split_whitespace().nth(1).map(|s| s.to_string())
        } else if t.starts_with("import ") {
            t[7..].split_whitespace().next()
                .map(|s| s.trim_end_matches(',').to_string())
        } else {
            None
        };

        let raw = match raw {
            Some(r) if !r.is_empty() => r,
            _ => continue,
        };
        if seen.contains(&raw) {
            continue;
        }
        seen.insert(raw.clone());

        let kind = if raw.starts_with('.') {
            ImportKind::Relative
        } else {
            ImportKind::External
        };

        entries.push(ImportEntry { raw, kind, resolved: None });
    }

    entries
}

fn parse_rust_imports(content: &str) -> Vec<ImportEntry> {
    let mut entries = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    for line in content.lines() {
        let t = line.trim();

        if (t.starts_with("use ") || t.starts_with("mod ")) && !t.starts_with("//") {
            let raw = t.trim_end_matches(';').to_string();
            if seen.contains(&raw) {
                continue;
            }
            seen.insert(raw.clone());
            entries.push(ImportEntry {
                raw,
                kind: ImportKind::RustDecl,
                resolved: None,
            });
        }
    }

    entries
}

// ---------------------------------------------------------------------------
// Reverse dependency search
// ---------------------------------------------------------------------------

fn find_importers(file_path: &str, cwd: &str) -> Vec<String> {
    let stem = match Path::new(file_path).file_stem() {
        Some(s) => s.to_string_lossy().to_string(),
        None => return Vec::new(),
    };

    // Simple pattern: any quoted string containing the stem.
    // Covers  from './foo'  and  require('../foo')  and  from '../../foo/index'
    let pattern = format!("['\"]([^'\"]*/){}['\"]", stem);

    let output = if cmd_available("rg") {
        Command::new("rg")
            .args([
                "--no-heading", "-l",
                "--type", "ts",
                "--type", "js",
                &pattern,
                cwd,
            ])
            .output()
    } else {
        Command::new("grep")
            .args([
                "-r", "-l", "-E",
                "--include=*.ts",
                "--include=*.tsx",
                "--include=*.js",
                "--include=*.jsx",
                &pattern,
                cwd,
            ])
            .output()
    };

    let output = match output {
        Ok(o) if o.status.success() || !o.stdout.is_empty() => o,
        _ => return Vec::new(),
    };

    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter(|l| !l.is_empty() && *l != file_path)
        .map(|l| l.to_string())
        .collect()
}

fn cmd_available(cmd: &str) -> bool {
    Command::new("which")
        .arg(cmd)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn parse_es_imports() {
        let src = r#"
import React from 'react';
import { foo } from './foo';
import type { Bar } from '../bar';
import './side-effect';
export { baz } from '../../baz';
"#;
        let entries = parse_js_imports(src, Path::new("/tmp"));
        let raws: Vec<&str> = entries.iter().map(|e| e.raw.as_str()).collect();
        assert!(raws.contains(&"react"));
        assert!(raws.contains(&"./foo"));
        assert!(raws.contains(&"../bar"));
        assert!(raws.contains(&"./side-effect"));
        assert!(raws.contains(&"../../baz"));
    }

    #[test]
    fn classify_relative_vs_external() {
        let src = "import x from './local';\nimport y from 'lodash';\n";
        let entries = parse_js_imports(src, Path::new("/tmp"));
        assert_eq!(entries[0].kind, ImportKind::Relative);
        assert_eq!(entries[1].kind, ImportKind::External);
    }

    #[test]
    fn dedup_imports() {
        let src = "import a from './a';\nimport b from './a';\n";
        let entries = parse_js_imports(src, Path::new("/tmp"));
        assert_eq!(entries.len(), 1);
    }

    #[test]
    fn parse_python() {
        let src = "import os\nfrom . import foo\nfrom pathlib import Path\n";
        let entries = parse_python_imports(src);
        let raws: Vec<&str> = entries.iter().map(|e| e.raw.as_str()).collect();
        assert!(raws.contains(&"os"));
        assert!(raws.contains(&"."));
        assert!(raws.contains(&"pathlib"));
    }

    #[test]
    fn parse_rust() {
        let src = "use std::collections::HashMap;\nmod foo;\n// use something;\n";
        let entries = parse_rust_imports(src);
        assert_eq!(entries.len(), 2);
        assert!(entries.iter().all(|e| e.kind == ImportKind::RustDecl));
    }
}
