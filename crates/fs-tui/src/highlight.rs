//! Lightweight syntax highlighter for the file editor.
//!
//! Produces per-character colour spans for a slice of lines.
//! Handles strings, line comments, block comments, keywords,
//! numbers, and function-call identifiers.

use ratatui::style::Color;

// ---------------------------------------------------------------------------
// Language detection
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq)]
pub enum Lang {
    Rust,
    Js,      // .js .jsx .ts .tsx .mjs .cjs
    Python,
    Go,
    C,       // .c .cpp .cc .h .hpp
    Shell,   // .sh .bash .zsh
    Generic,
}

impl Lang {
    pub fn from_path(path: &str) -> Self {
        let ext = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
        match ext.as_str() {
            "rs"                           => Lang::Rust,
            "js"|"jsx"|"ts"|"tsx"|"mjs"|"cjs" => Lang::Js,
            "py"                           => Lang::Python,
            "go"                           => Lang::Go,
            "c"|"cpp"|"cc"|"h"|"hpp"       => Lang::C,
            "sh"|"bash"|"zsh"              => Lang::Shell,
            _                              => Lang::Generic,
        }
    }

    fn keywords(self) -> &'static [&'static str] {
        match self {
            Lang::Rust => &[
                "as","async","await","break","const","continue","crate","dyn","else",
                "enum","extern","false","fn","for","if","impl","in","let","loop",
                "match","mod","move","mut","pub","ref","return","self","Self","static",
                "struct","super","trait","true","type","unsafe","use","where","while",
                "Box","Vec","Option","Result","Some","None","Ok","Err","String","str",
                "i8","i16","i32","i64","i128","isize","u8","u16","u32","u64","u128",
                "usize","f32","f64","bool","char",
            ],
            Lang::Js => &[
                "async","await","break","case","catch","class","const","continue",
                "debugger","default","delete","do","else","export","extends","false",
                "finally","for","from","function","if","import","in","instanceof",
                "let","new","null","of","return","static","super","switch","this",
                "throw","true","try","typeof","undefined","var","void","while","with",
                "yield","interface","type","enum","implements","abstract","declare",
                "namespace","module","readonly","keyof","never","any","unknown",
                "number","string","boolean","object","symbol","bigint",
            ],
            Lang::Python => &[
                "False","None","True","and","as","assert","async","await","break",
                "class","continue","def","del","elif","else","except","finally","for",
                "from","global","if","import","in","is","lambda","nonlocal","not","or",
                "pass","raise","return","try","while","with","yield","int","str","list",
                "dict","set","tuple","float","bool","bytes","print","len","range",
                "type","self","cls",
            ],
            Lang::Go => &[
                "break","case","chan","const","continue","default","defer","else",
                "fallthrough","for","func","go","goto","if","import","interface","map",
                "package","range","return","select","struct","switch","type","var",
                "nil","true","false","string","int","int8","int16","int32","int64",
                "uint","uint8","uint16","uint32","uint64","uintptr","float32","float64",
                "complex64","complex128","byte","rune","bool","error","any",
            ],
            Lang::C => &[
                "auto","break","case","char","const","continue","default","do","double",
                "else","enum","extern","float","for","goto","if","inline","int","long",
                "register","restrict","return","short","signed","sizeof","static",
                "struct","switch","typedef","union","unsigned","void","volatile","while",
                "nullptr","true","false","bool","NULL","class","public","private",
                "protected","namespace","template","typename","virtual","override",
                "final","new","delete","this","using","operator","explicit","friend",
            ],
            Lang::Shell | Lang::Generic => &[],
        }
    }

    /// Returns (line_comment_prefix, block_open, block_close).
    fn comment_markers(self) -> (&'static str, Option<(&'static str, &'static str)>) {
        match self {
            Lang::Rust | Lang::Js | Lang::C => ("//", Some(("/*", "*/"))),
            Lang::Python => ("#", None),
            Lang::Go     => ("//", Some(("/*", "*/"))),
            Lang::Shell  => ("#", None),
            Lang::Generic => ("#", None),
        }
    }

    /// Whether to highlight `#[...]` / `@decorator` / `#!` prefixes distinctly.
    fn has_attributes(self) -> bool {
        matches!(self, Lang::Rust)
    }
}

// ---------------------------------------------------------------------------
// Per-line highlight output
// ---------------------------------------------------------------------------

/// A coloured span: byte range [start, end) in the source line.
#[derive(Debug, Clone)]
pub struct Span {
    pub start: usize,
    pub end:   usize,
    pub color: Color,
}

// ---------------------------------------------------------------------------
// Highlighter state (carried across lines for block comments)
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq)]
pub enum LineState {
    Normal,
    InBlockComment,
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/// Highlight `lines[start..end]`, threading block-comment state from line 0.
/// Returns one `Vec<Span>` per line in `start..end`.
pub fn highlight_range(
    lines: &[String],
    visible_start: usize,
    visible_end: usize,
    lang: Lang,
) -> Vec<Vec<Span>> {
    // Fast-forward state to visible_start without collecting spans.
    let mut state = LineState::Normal;
    for i in 0..visible_start.min(lines.len()) {
        fast_forward_state(&lines[i], lang, &mut state);
    }

    // Collect spans for visible lines.
    let end = visible_end.min(lines.len());
    (visible_start..end)
        .map(|i| {
            let mut spans = Vec::new();
            highlight_line(&lines[i], lang, &mut state, &mut spans);
            spans
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Internal: fast-forward state without collecting
// ---------------------------------------------------------------------------

fn fast_forward_state(line: &str, lang: Lang, state: &mut LineState) {
    let (_, block) = lang.comment_markers();
    let bytes = line.as_bytes();
    let len = bytes.len();
    let mut i = 0;

    if *state == LineState::InBlockComment {
        if let Some((_, close)) = block {
            while i + close.len() <= len {
                if &bytes[i..i + close.len()] == close.as_bytes() {
                    i += close.len();
                    *state = LineState::Normal;
                    break;
                }
                i += 1;
            }
        }
        if *state == LineState::InBlockComment { return; }
    }

    while i < len {
        // Skip strings
        if bytes[i] == b'"' || bytes[i] == b'\'' || bytes[i] == b'`' {
            let q = bytes[i];
            i += 1;
            while i < len {
                if bytes[i] == b'\\' { i += 2; continue; }
                if bytes[i] == q { i += 1; break; }
                i += 1;
            }
            continue;
        }
        // Block comment open
        if let Some((open, close)) = block {
            if i + open.len() <= len && &bytes[i..i + open.len()] == open.as_bytes() {
                i += open.len();
                *state = LineState::InBlockComment;
                while i + close.len() <= len {
                    if &bytes[i..i + close.len()] == close.as_bytes() {
                        i += close.len();
                        *state = LineState::Normal;
                        break;
                    }
                    i += 1;
                }
                if *state == LineState::InBlockComment { return; }
                continue;
            }
        }
        // Line comment
        let (lc, _) = lang.comment_markers();
        if i + lc.len() <= len && &bytes[i..i + lc.len()] == lc.as_bytes() {
            return;
        }
        i += 1;
    }
}

// ---------------------------------------------------------------------------
// Internal: full highlight for one line
// ---------------------------------------------------------------------------

fn highlight_line(line: &str, lang: Lang, state: &mut LineState, out: &mut Vec<Span>) {
    let (lc_prefix, block) = lang.comment_markers();
    let bytes = line.as_bytes();
    let len = bytes.len();
    let mut i = 0;

    // If we're already inside a block comment, consume until close.
    if *state == LineState::InBlockComment {
        let start = 0;
        if let Some((_, close)) = block {
            while i + close.len() <= len {
                if &bytes[i..i + close.len()] == close.as_bytes() {
                    i += close.len();
                    *state = LineState::Normal;
                    out.push(Span { start, end: i, color: COMMENT });
                    break;
                }
                i += 1;
            }
            if *state == LineState::InBlockComment {
                out.push(Span { start, end: len, color: COMMENT });
                return;
            }
        } else {
            out.push(Span { start, end: len, color: COMMENT });
            return;
        }
    }

    // Normal scanning.
    while i < len {
        let b = bytes[i];

        // Rust attributes: #[...] or #![...]
        if lang.has_attributes() && b == b'#' && i + 1 < len
            && (bytes[i + 1] == b'[' || (bytes[i + 1] == b'!' && i + 2 < len && bytes[i + 2] == b'['))
        {
            let start = i;
            i += 1;
            let mut depth = 0usize;
            while i < len {
                if bytes[i] == b'[' { depth += 1; }
                else if bytes[i] == b']' {
                    i += 1;
                    depth = depth.saturating_sub(1);
                    if depth == 0 { break; }
                    continue;
                }
                i += 1;
            }
            out.push(Span { start, end: i, color: ATTRIBUTE });
            continue;
        }

        // Line comment.
        if i + lc_prefix.len() <= len && &bytes[i..i + lc_prefix.len()] == lc_prefix.as_bytes() {
            out.push(Span { start: i, end: len, color: COMMENT });
            return;
        }

        // Block comment open.
        if let Some((open, close)) = block {
            if i + open.len() <= len && &bytes[i..i + open.len()] == open.as_bytes() {
                let start = i;
                i += open.len();
                *state = LineState::InBlockComment;
                while i + close.len() <= len {
                    if &bytes[i..i + close.len()] == close.as_bytes() {
                        i += close.len();
                        *state = LineState::Normal;
                        break;
                    }
                    i += 1;
                }
                out.push(Span { start, end: i, color: COMMENT });
                if *state == LineState::InBlockComment { return; }
                continue;
            }
        }

        // String / char / template literal.
        if b == b'"' || b == b'`' || (b == b'\'' && lang != Lang::Rust) {
            let start = i;
            let q = b;
            i += 1;
            while i < len {
                if bytes[i] == b'\\' { i += 2; continue; }
                if bytes[i] == q { i += 1; break; }
                i += 1;
            }
            out.push(Span { start, end: i, color: STRING });
            continue;
        }

        // Rust lifetime / char literal: 'x or 'static
        if lang == Lang::Rust && b == b'\'' {
            let start = i;
            i += 1;
            // lifetime: 'ident
            if i < len && (bytes[i].is_ascii_alphabetic() || bytes[i] == b'_') {
                while i < len && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_') {
                    i += 1;
                }
                // If followed by another ' it's a char literal, otherwise lifetime
                let end = if i < len && bytes[i] == b'\'' { i += 1; i } else { i };
                out.push(Span { start, end, color: LIFETIME });
            } else if i < len {
                // char literal: '.'  or '\n' etc
                if bytes[i] == b'\\' { i += 1; }
                if i < len { i += 1; }
                if i < len && bytes[i] == b'\'' { i += 1; }
                out.push(Span { start, end: i, color: STRING });
            }
            continue;
        }

        // Number literal.
        if b.is_ascii_digit()
            || (b == b'.' && i + 1 < len && bytes[i + 1].is_ascii_digit())
            || (b == b'0' && i + 1 < len && (bytes[i + 1] == b'x' || bytes[i + 1] == b'b' || bytes[i + 1] == b'o'))
        {
            let start = i;
            while i < len && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'.' || bytes[i] == b'_') {
                i += 1;
            }
            out.push(Span { start, end: i, color: NUMBER });
            continue;
        }

        // Identifier — keyword, type, or function call.
        if b.is_ascii_alphabetic() || b == b'_' {
            let start = i;
            while i < len && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_') {
                i += 1;
            }
            let word = &line[start..i];

            // Skip trailing whitespace to check for '('
            let mut j = i;
            while j < len && bytes[j] == b' ' { j += 1; }
            let followed_by_paren = j < len && bytes[j] == b'(';

            let color = if lang.keywords().contains(&word) {
                KEYWORD
            } else if followed_by_paren {
                FUNCTION
            } else if word.len() > 1 && bytes[start].is_ascii_uppercase() {
                TYPE
            } else {
                // No span needed — default text color
                continue;
            };

            out.push(Span { start, end: i, color });
            continue;
        }

        i += 1;
    }
}

// ---------------------------------------------------------------------------
// Colour constants (tuned for light terminal background)
// ---------------------------------------------------------------------------

const KEYWORD:   Color = Color::Blue;
const FUNCTION:  Color = Color::Cyan;
const TYPE:      Color = Color::Magenta;
const STRING:    Color = Color::Green;
const NUMBER:    Color = Color::Magenta;
const COMMENT:   Color = Color::DarkGray;
const ATTRIBUTE: Color = Color::Yellow;
const LIFETIME:  Color = Color::Cyan;
