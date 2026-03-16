import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { shell } from 'electron'
import type { AuthStatus } from '../shared/types'

const execFileAsync = promisify(execFile)
const isWindows = process.platform === 'win32'

/** Try running a claude binary candidate — returns the candidate string on success */
async function tryBin(bin: string): Promise<string> {
  await execFileAsync(bin, ['--version'], {
    timeout: 8000,
    // shell: true lets Windows run .ps1 / .cmd files
    shell: isWindows,
  })
  return bin
}

/** Resolve the claude CLI binary — checks all candidates in parallel */
async function findClaudeBin(): Promise<string | null> {
  // 0. User override via FLUIDSTATE_CLAUDE_PATH env var
  const envOverride = process.env.FLUIDSTATE_CLAUDE_PATH
  if (envOverride && existsSync(envOverride)) {
    try {
      await tryBin(envOverride)
      return envOverride
    } catch { /* fall through */ }
  }

  const home = homedir()
  const candidates: string[] = []

  if (isWindows) {
    const appData = process.env.APPDATA || join(home, 'AppData', 'Roaming')
    const localAppData = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local')
    candidates.push(
      'claude',                                        // on PATH
      join(appData, 'npm', 'claude.ps1'),
      join(appData, 'npm', 'claude.cmd'),
      join(appData, 'npm', 'claude'),
      join(localAppData, 'Programs', 'claude', 'claude.exe'),
      join(home, '.claude', 'local', 'claude.exe'),
    )
  } else {
    candidates.push(
      'claude',
      '/usr/local/bin/claude',
      '/opt/homebrew/bin/claude',
      `${home}/.npm-global/bin/claude`,
      `${home}/.local/bin/claude`,
    )
  }

  try {
    return await Promise.any(candidates.map(bin => tryBin(bin)))
  } catch {
    return null
  }
}

let cachedBin: string | null = null
let pendingLookup: Promise<string | null> | null = null

async function claudeBin(): Promise<string | null> {
  if (cachedBin) return cachedBin
  // Deduplicate concurrent calls — share a single in-flight lookup
  if (pendingLookup) return pendingLookup
  pendingLookup = findClaudeBin().then(found => {
    if (found) cachedBin = found
    pendingLookup = null
    return found
  }).catch(() => {
    pendingLookup = null
    return null
  })
  return pendingLookup
}

/** Synchronous accessor — returns cached path (or null if not yet resolved / not found) */
export function getClaudePath(): string | null {
  return cachedBin ?? null
}

/** Ensure the claude binary has been resolved (call early at startup) */
export async function ensureClaudeBin(): Promise<string | null> {
  return claudeBin()
}

/** Check current auth status */
export async function getAuthStatus(): Promise<AuthStatus> {
  const bin = await claudeBin()
  if (!bin) {
    return {
      authenticated: false,
      error: 'Claude CLI not found. Install with: npm install -g @anthropic-ai/claude-code',
    }
  }

  try {
    const { stdout, stderr } = await execFileAsync(bin, ['auth', 'status'], {
      timeout: 10_000,
      env: { ...process.env, NO_COLOR: '1' },
      shell: isWindows,
    })
    const text = (stdout + '\n' + stderr).trim().toLowerCase()

    if (text.includes('not authenticated') || text.includes('not logged in') || text.includes('no valid')) {
      return { authenticated: false }
    }

    // Try to extract account info
    const fullText = stdout + '\n' + stderr
    const emailMatch = fullText.match(/(?:as|account|email)[:\s]+(\S+@\S+)/i)
    const orgMatch = fullText.match(/(?:org|organization)[:\s]+(.+)/i)

    return {
      authenticated: true,
      email: emailMatch?.[1],
      organization: orgMatch?.[1]?.trim(),
    }
  } catch (err: any) {
    const msg = (err?.stderr || err?.stdout || err?.message || '').toString()
    // If the command exited non-zero, likely not authenticated
    if (err?.code !== undefined || msg.toLowerCase().includes('not')) {
      return { authenticated: false }
    }
    return { authenticated: false, error: msg.slice(0, 200) }
  }
}

/** Run `claude auth login` — opens browser for OAuth */
export async function login(): Promise<AuthStatus> {
  const bin = await claudeBin()
  if (!bin) {
    return {
      authenticated: false,
      error: 'Claude CLI not found. Install with: npm install -g @anthropic-ai/claude-code',
    }
  }

  try {
    const child = spawn(bin, ['auth', 'login'], {
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: isWindows,
    })

    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (d: Buffer) => {
      const chunk = d.toString()
      stdout += chunk
      // If the CLI prints a URL, open it in the system browser
      const urlMatch = chunk.match(/https?:\/\/\S+/)
      if (urlMatch) {
        shell.openExternal(urlMatch[0]).catch(() => {})
      }
    })
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })

    const code = await new Promise<number>((resolve) => {
      child.on('close', (c) => resolve(c ?? 1))
      child.on('error', () => resolve(1))
      // Timeout after 2 minutes
      setTimeout(() => { child.kill(); resolve(1) }, 120_000)
    })

    if (code !== 0 && !stdout.toLowerCase().includes('success')) {
      return { authenticated: false, error: stderr.trim() || stdout.trim() || 'Login failed' }
    }

    // Re-check status after login
    return getAuthStatus()
  } catch (err: any) {
    return { authenticated: false, error: err?.message || 'Login failed' }
  }
}

/** Run `claude auth logout` */
export async function logout(): Promise<AuthStatus> {
  const bin = await claudeBin()
  if (!bin) {
    return { authenticated: false, error: 'Claude CLI not found' }
  }

  try {
    await execFileAsync(bin, ['auth', 'logout'], {
      timeout: 10_000,
      env: { ...process.env, NO_COLOR: '1' },
      shell: isWindows,
    })
    return { authenticated: false }
  } catch (err: any) {
    return { authenticated: false, error: err?.message || 'Logout failed' }
  }
}

/** Read OAuth access token — tries macOS keychain first, falls back to ~/.claude.json */
async function getOAuthToken(): Promise<string | null> {
  // macOS keychain (where Claude Code stores tokens)
  try {
    const { stdout } = await execFileAsync(
      'security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
      { timeout: 3000 },
    )
    const creds = JSON.parse(stdout.trim())
    if (creds?.claudeAiOauth?.accessToken) return creds.claudeAiOauth.accessToken
  } catch { /* not in keychain */ }

  // Fallback: ~/.claude.json
  try {
    const configPath = join(process.env.CLAUDE_CONFIG_DIR || homedir(), '.claude.json')
    const raw = await readFile(configPath, 'utf-8')
    const config = JSON.parse(raw)
    return config?.claudeAiOauth?.accessToken || null
  } catch {
    return null
  }
}

/** Fetch real usage data from Anthropic API */
export async function fetchUsage(): Promise<Record<string, unknown>> {
  const token = await getOAuthToken()
  if (!token) return { error: 'No OAuth token found' }

  const baseUrl = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com'
  const res = await fetch(`${baseUrl}/api/oauth/usage`, {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      'anthropic-beta': 'oauth-2025-04-20',
    },
    signal: AbortSignal.timeout(5000),
  })

  if (!res.ok) return { error: `API ${res.status}: ${res.statusText}` }
  return res.json()
}
