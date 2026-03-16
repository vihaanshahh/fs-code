/**
 * Cross-platform environment sanitization utilities for the agent subprocess.
 *
 * Extracted into a standalone module so the logic is testable without
 * Electron / SDK dependencies.
 */

// --- Environment sanitization ---
// Only pass through known-safe variables to prevent NODE_OPTIONS, CLAUDECODE, ELECTRON_* etc.
// from leaking into the CLI subprocess and causing exit code 1.
// Handles both Unix and Windows environments.
export function buildCleanEnv(
  env: Record<string, string | undefined>,
  isWindows: boolean,
): Record<string, string> {
  const clean: Record<string, string> = {}

  // Common cross-platform variables
  const PASSTHROUGH = [
    'PATH', 'LANG', 'TEMP', 'TMP',
  ]

  // Unix-only variables
  const UNIX_PASSTHROUGH = [
    'HOME', 'USER', 'LOGNAME', 'SHELL',
    'TMPDIR', 'TERM',
    'SSH_AUTH_SOCK', 'DISPLAY', 'COLORTERM',
  ]

  // Windows-critical variables — without these, subprocess spawning and
  // path resolution will break on Windows.
  const WIN_PASSTHROUGH = [
    'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME',
    'SYSTEMROOT', 'WINDIR', 'COMSPEC',
    'PATHEXT', 'APPDATA', 'LOCALAPPDATA',
    'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)',
    'PROGRAMW6432', 'COMMONPROGRAMFILES',
    'SYSTEMDRIVE', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE',
    'OS',
  ]

  const platformPassthrough = isWindows
    ? [...PASSTHROUGH, ...WIN_PASSTHROUGH]
    : [...PASSTHROUGH, ...UNIX_PASSTHROUGH]

  const PASSTHROUGH_PREFIXES = isWindows
    ? ['ANTHROPIC_', 'CLAUDE_']
    : ['LC_', 'XDG_', 'ANTHROPIC_', 'CLAUDE_']

  // On Windows, env var names are case-insensitive. Normalize the passthrough
  // list to uppercase and compare with uppercased keys so we never miss a match
  // (e.g. "Path" vs "PATH").
  const passthroughUpper = new Set(platformPassthrough.map(k => k.toUpperCase()))

  for (const [key, val] of Object.entries(env)) {
    if (!val) continue
    const keyUpper = key.toUpperCase()
    if (keyUpper === 'CLAUDECODE' || keyUpper === 'NODE_OPTIONS' || keyUpper === 'NODE_DEBUG'
        || keyUpper === 'DEBUG' || keyUpper.startsWith('ELECTRON_')) continue
    if (passthroughUpper.has(keyUpper) || PASSTHROUGH_PREFIXES.some(p => keyUpper.startsWith(p))) {
      // Preserve the original key casing from the environment
      clean[key] = val
    }
  }
  clean.ELECTRON_RUN_AS_NODE = '1'
  return clean
}

// --- Preflight: CLI accessibility check ---
// Returns the correct fs.constants flag for checking CLI accessibility.
// Windows does not honor X_OK — it always fails even for valid files.
export function getCliAccessFlag(isWindows: boolean): number {
  // fs.constants.R_OK = 4, fs.constants.X_OK = 1
  // We import from 'node:fs' at runtime, but accept the constant values here
  // to keep this module free of side-effects for testing.
  return isWindows ? 4 /* R_OK */ : 1 /* X_OK */
}

// --- Preflight: CLI access error message ---
export function getCliAccessError(cliPath: string, isWindows: boolean): string {
  return isWindows
    ? `CLI file exists but is not readable: ${cliPath}`
    : `CLI file exists but is not executable: ${cliPath}`
}
