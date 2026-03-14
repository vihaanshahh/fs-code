import { app, dialog } from 'electron'
import { unlink, access, readFile, writeFile, mkdir, symlink, copyFile, lstat, readlink } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Path where the symlink / script is installed for the user */
function getInstallPath(): string {
  if (process.platform === 'win32') {
    const localAppData =
      process.env.LOCALAPPDATA || join(process.env.USERPROFILE || '', 'AppData', 'Local')
    return join(localAppData, 'FluidState', 'bin', 'fluidstate.cmd')
  }
  return '/usr/local/bin/fluidstate'
}

/** Path to the bundled CLI script inside the packaged app */
function getBundledScriptPath(): string {
  const ext = process.platform === 'win32' ? 'fluidstate.cmd' : 'fluidstate'
  return join(process.resourcesPath, 'bin', ext)
}

/** Path to the preferences file */
function getPrefsPath(): string {
  return join(app.getPath('userData'), 'cli-setup.json')
}

interface CLIPrefs {
  /** 'installed' | 'declined' | 'later' */
  status: string
}

async function readPrefs(): Promise<CLIPrefs | null> {
  try {
    const raw = await readFile(getPrefsPath(), 'utf-8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

async function writePrefs(prefs: CLIPrefs): Promise<void> {
  await writeFile(getPrefsPath(), JSON.stringify(prefs, null, 2), 'utf-8')
}

/**
 * Best-effort install of the bash CLI script into WSL's ~/.local/bin.
 * Called from the Windows side after installing the .cmd script.
 * Silently does nothing if WSL is not installed or the command fails.
 */
async function installIntoWSL(): Promise<void> {
  if (process.platform !== 'win32') return

  try {
    // Check if WSL is available
    await execFileAsync('wsl', ['--status'])
  } catch {
    return // WSL not installed
  }

  try {
    // Convert the bundled bash script's Windows path to a WSL path
    const bundledBash = join(process.resourcesPath, 'bin', 'fluidstate')
    const { stdout: wslPath } = await execFileAsync('wsl', [
      '-e',
      'wslpath',
      '-u',
      bundledBash.replace(/\\/g, '\\\\'),
    ])
    const wslScript = wslPath.trim()

    // Create symlink in ~/.local/bin (doesn't need sudo, most distros have it in PATH)
    await execFileAsync('wsl', [
      '-e',
      'bash',
      '-c',
      `mkdir -p ~/.local/bin && rm -f ~/.local/bin/fluidstate && ln -s '${wslScript}' ~/.local/bin/fluidstate`,
    ])
    console.log('[cli] WSL CLI symlink installed to ~/.local/bin/fluidstate')
  } catch (err: any) {
    console.warn('[cli] WSL CLI install failed (non-fatal):', err.message)
  }
}

/**
 * Check if the CLI is installed and whether the symlink is stale.
 * A stale symlink means the file exists but points to a location that no
 * longer contains the bundled script (e.g. the app was moved/updated).
 */
export async function isCLIInstalled(): Promise<{
  installed: boolean
  stale: boolean
  path?: string
}> {
  const installPath = getInstallPath()

  try {
    if (process.platform === 'win32') {
      await access(installPath)
      return { installed: true, stale: false, path: installPath }
    }

    // Check if the symlink exists
    const stats = await lstat(installPath)
    if (!stats.isSymbolicLink()) {
      // It's a regular file (old-style install) — treat as stale so we replace it
      return { installed: true, stale: true, path: installPath }
    }

    // It's a symlink — check if it points to the current bundled script
    const target = await readlink(installPath)
    const bundled = getBundledScriptPath()
    if (target === bundled) {
      // Valid symlink pointing to current app location
      try {
        await access(bundled)
        return { installed: true, stale: false, path: installPath }
      } catch {
        // Symlink target doesn't exist (app removed?)
        return { installed: true, stale: true, path: installPath }
      }
    }

    // Symlink points to a different location (app was moved/updated)
    return { installed: true, stale: true, path: installPath }
  } catch {
    return { installed: false, stale: false }
  }
}

/** Install the CLI command */
export async function installCLI(): Promise<{ success: boolean; path?: string; error?: string }> {
  const installPath = getInstallPath()
  const bundledScript = getBundledScriptPath()

  try {
    if (process.platform === 'win32') {
      // Windows: copy the bundled .cmd script and add dir to PATH
      const dir = dirname(installPath)
      await mkdir(dir, { recursive: true })
      await copyFile(bundledScript, installPath)

      try {
        await execFileAsync('powershell', [
          '-Command',
          `$path = [Environment]::GetEnvironmentVariable('PATH', 'User'); if ($path -notlike '*${dir}*') { [Environment]::SetEnvironmentVariable('PATH', "$path;${dir}", 'User') }`,
        ])
      } catch {
        // Non-fatal — user may need to add manually
      }

      // Also install into WSL if available (best-effort, uses ~/.local/bin — no sudo)
      await installIntoWSL()

      await writePrefs({ status: 'installed' })
      return { success: true, path: installPath }
    }

    // macOS/Linux: create a symlink from /usr/local/bin/fluidstate → bundled script
    const createSymlink = async (): Promise<void> => {
      // Remove any existing file/symlink first
      try {
        await unlink(installPath)
      } catch (e: any) {
        if (e.code !== 'ENOENT') throw e
      }
      await symlink(bundledScript, installPath)
    }

    try {
      await createSymlink()
      await writePrefs({ status: 'installed' })
      return { success: true, path: installPath }
    } catch (directErr: any) {
      if (directErr.code !== 'EACCES') throw directErr

      // Need elevated permissions
      if (process.platform === 'darwin') {
        try {
          await execFileAsync('osascript', [
            '-e',
            `do shell script "rm -f '${installPath}' && ln -s '${bundledScript}' '${installPath}'" with administrator privileges`,
          ])
          await writePrefs({ status: 'installed' })
          return { success: true, path: installPath }
        } catch (err: any) {
          if (err.message?.includes('User canceled')) {
            return { success: false, error: 'Installation cancelled by user' }
          }
          throw err
        }
      } else {
        // Linux: use pkexec
        try {
          await execFileAsync('pkexec', [
            'bash',
            '-c',
            `rm -f '${installPath}' && ln -s '${bundledScript}' '${installPath}'`,
          ])
          await writePrefs({ status: 'installed' })
          return { success: true, path: installPath }
        } catch (err: any) {
          return { success: false, error: `Failed to install: ${err.message}` }
        }
      }
    }
  } catch (err: any) {
    return { success: false, error: err.message || String(err) }
  }
}

/** Uninstall the CLI command */
export async function uninstallCLI(): Promise<{ success: boolean; error?: string }> {
  const installPath = getInstallPath()

  try {
    try {
      await unlink(installPath)
      await writePrefs({ status: 'declined' })
      return { success: true }
    } catch (directErr: any) {
      if (directErr.code === 'ENOENT') {
        await writePrefs({ status: 'declined' })
        return { success: true }
      }
      if (directErr.code !== 'EACCES') throw directErr

      if (process.platform === 'darwin') {
        await execFileAsync('osascript', [
          '-e',
          `do shell script "rm -f '${installPath}'" with administrator privileges`,
        ])
        await writePrefs({ status: 'declined' })
        return { success: true }
      } else if (process.platform !== 'win32') {
        await execFileAsync('pkexec', ['rm', '-f', installPath])
        await writePrefs({ status: 'declined' })
        return { success: true }
      }
      throw directErr
    }
  } catch (err: any) {
    return { success: false, error: err.message || String(err) }
  }
}

/**
 * Auto-install CLI on first launch.
 * - If already installed & valid → skip
 * - If stale symlink → silently re-install (user already consented)
 * - If not installed → show one-time dialog
 * Skipped in dev mode.
 */
export async function autoInstallCLI(): Promise<void> {
  if (!app.isPackaged) return

  const status = await isCLIInstalled()

  if (status.installed && !status.stale) return

  if (status.installed && status.stale) {
    // User previously consented — silently fix the symlink
    console.log('[cli] stale CLI symlink detected, re-installing...')
    const result = await installCLI()
    if (result.success) {
      console.log('[cli] CLI symlink updated:', result.path)
    } else {
      console.warn('[cli] failed to update CLI symlink:', result.error)
    }
    return
  }

  // Not installed — check preferences
  const prefs = await readPrefs()
  if (prefs?.status === 'declined') return
  // 'later' → ask again next launch (which is now)
  // null → first launch

  const { response } = await dialog.showMessageBox({
    type: 'info',
    title: 'Install CLI Command',
    message: "Install 'fluidstate' command?",
    detail:
      "This lets you run 'fluidstate .' from any terminal to open FluidState in a directory.\n\nA symlink will be created at /usr/local/bin/fluidstate.",
    buttons: ['Install Now', 'Remind Me Later', "Don't Ask Again"],
    defaultId: 0,
    cancelId: 1,
  })

  if (response === 0) {
    const result = await installCLI()
    if (result.success) {
      dialog.showMessageBox({
        type: 'info',
        title: 'CLI Installed',
        message: "'fluidstate' command installed successfully",
        detail: `You can now run 'fluidstate .' from any terminal.\n\nInstalled to: ${result.path}`,
      })
    } else {
      dialog.showMessageBox({
        type: 'error',
        title: 'CLI Installation Failed',
        message: 'Could not install the CLI command',
        detail: result.error || 'Unknown error',
      })
    }
  } else if (response === 2) {
    await writePrefs({ status: 'declined' })
  } else {
    await writePrefs({ status: 'later' })
  }
}
