//! System clipboard bridge for the editor.
//!
//! Uses the native clipboard toolchain when available:
//!   - macOS: `pbcopy` / `pbpaste`
//!   - Linux: `wl-copy` / `wl-paste`, then `xclip`, then `xsel`

use std::io::Write;
use std::process::{Command, Stdio};

#[derive(Clone, Copy)]
struct ClipboardCommand {
    program: &'static str,
    args: &'static [&'static str],
}

pub fn copy_text(text: &str) -> Result<(), String> {
    let mut last_err = None;

    for command in copy_commands() {
        match run_copy(*command, text) {
            Ok(()) => return Ok(()),
            Err(e) => last_err = Some(e),
        }
    }

    Err(last_err.unwrap_or_else(|| "no clipboard helper available".into()))
}

pub fn paste_text() -> Option<String> {
    for command in paste_commands() {
        if let Ok(text) = run_paste(*command) {
            return Some(text);
        }
    }
    None
}

fn run_copy(command: ClipboardCommand, text: &str) -> Result<(), String> {
    let mut child = Command::new(command.program)
        .args(command.args)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;

    if let Some(stdin) = child.stdin.as_mut() {
        stdin
            .write_all(text.as_bytes())
            .map_err(|e| e.to_string())?;
    }

    let status = child.wait().map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("{} exited with {}", command.program, status))
    }
}

fn run_paste(command: ClipboardCommand) -> Result<String, String> {
    let output = Command::new(command.program)
        .args(command.args)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(format!("{} exited with {}", command.program, output.status));
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn copy_commands() -> &'static [ClipboardCommand] {
    #[cfg(target_os = "macos")]
    {
        const CMDS: &[ClipboardCommand] = &[ClipboardCommand {
            program: "pbcopy",
            args: &[],
        }];
        CMDS
    }

    #[cfg(not(target_os = "macos"))]
    {
        const CMDS: &[ClipboardCommand] = &[
            ClipboardCommand {
                program: "wl-copy",
                args: &[],
            },
            ClipboardCommand {
                program: "xclip",
                args: &["-selection", "clipboard"],
            },
            ClipboardCommand {
                program: "xsel",
                args: &["--clipboard", "--input"],
            },
        ];
        CMDS
    }
}

fn paste_commands() -> &'static [ClipboardCommand] {
    #[cfg(target_os = "macos")]
    {
        const CMDS: &[ClipboardCommand] = &[ClipboardCommand {
            program: "pbpaste",
            args: &[],
        }];
        CMDS
    }

    #[cfg(not(target_os = "macos"))]
    {
        const CMDS: &[ClipboardCommand] = &[
            ClipboardCommand {
                program: "wl-paste",
                args: &[],
            },
            ClipboardCommand {
                program: "xclip",
                args: &["-selection", "clipboard", "-o"],
            },
            ClipboardCommand {
                program: "xsel",
                args: &["--clipboard", "--output"],
            },
        ];
        CMDS
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn candidate_order_matches_platform() {
        let copy = copy_commands();
        let paste = paste_commands();

        #[cfg(target_os = "macos")]
        {
            assert_eq!(copy[0].program, "pbcopy");
            assert_eq!(paste[0].program, "pbpaste");
        }

        #[cfg(not(target_os = "macos"))]
        {
            assert_eq!(copy[0].program, "wl-copy");
            assert_eq!(paste[0].program, "wl-paste");
        }
    }
}
