/**
 * Auto-updater — wraps electron-updater for GitHub Releases.
 * Uses SHA-512 verification (works without code signing).
 */

import { autoUpdater } from 'electron-updater'
import type { UpdateInfo } from 'electron-updater'
import { app } from 'electron'
import type { BrowserWindow } from 'electron'
import { IPC } from '../shared/types'
import { getGitHubToken } from './keystore'

let mainWindow: BrowserWindow | null = null

/** How often to poll for new releases (30 minutes) */
const POLL_INTERVAL_MS = 30 * 60 * 1000

let pollTimer: ReturnType<typeof setInterval> | null = null

export function setMainWindow(win: BrowserWindow) {
  mainWindow = win
}

function sendStatus(status: unknown) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC.UPDATE_STATUS, status)
  }
}

export function initAutoUpdater() {
  // Don't check for updates in dev mode
  if (process.env.ELECTRON_RENDERER_URL) {
    console.log('[updater] skipping in dev mode')
    return
  }

  // Don't auto-download — let the user choose
  autoUpdater.autoDownload = false
  // If user downloaded but didn't restart, install on next quit
  autoUpdater.autoInstallOnAppQuit = true

  // Private repo auth — set token for GitHub API requests
  applyGitHubToken()

  autoUpdater.on('checking-for-update', () => {
    console.log('[updater] checking for update...')
    sendStatus({ state: 'checking' })
  })

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    console.log(`[updater] update available: v${info.version}`)
    sendStatus({
      state: 'available',
      version: info.version,
      releaseNotes: typeof info.releaseNotes === 'string'
        ? info.releaseNotes
        : undefined,
    })
    // Stop polling once we know an update is available — no point rechecking
    stopPolling()
  })

  autoUpdater.on('update-not-available', () => {
    console.log('[updater] up to date')
    sendStatus({
      state: 'not-available',
      currentVersion: app.getVersion(),
    })
  })

  autoUpdater.on('download-progress', (progress) => {
    sendStatus({
      state: 'downloading',
      percent: Math.round(progress.percent),
    })
  })

  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    console.log(`[updater] update downloaded: v${info.version}`)
    sendStatus({
      state: 'downloaded',
      version: info.version,
    })
  })

  autoUpdater.on('error', (err) => {
    console.error('[updater] error:', err.message)
    sendStatus({
      state: 'error',
      message: err.message || String(err),
    })
  })

  // Check on startup after a short delay (don't compete with app init)
  setTimeout(() => {
    checkForUpdates()
  }, 10_000)

  // Poll periodically so users always see fresh update availability
  startPolling()
}

function startPolling() {
  if (pollTimer) return
  pollTimer = setInterval(() => {
    console.log('[updater] periodic check')
    checkForUpdates()
  }, POLL_INTERVAL_MS)
  pollTimer.unref() // don't keep the app alive just for polling
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

/**
 * Read the GitHub token from the encrypted keystore and configure
 * electron-updater to use it. Called on init and before every
 * check/download so the user can paste a token at any time.
 */
function applyGitHubToken() {
  const token = getGitHubToken()
  if (token) {
    autoUpdater.requestHeaders = { Authorization: `token ${token}` }
    console.log('[updater] GitHub token applied')
  } else {
    autoUpdater.requestHeaders = {}
    console.log('[updater] no GitHub token — public release check only')
  }
}

/** Re-apply token and notify the renderer of the current token status */
export function refreshGitHubToken() {
  applyGitHubToken()
  // Trigger a fresh check so the user sees immediate feedback after saving a token
  checkForUpdates()
}

export async function checkForUpdates() {
  applyGitHubToken() // pick up any newly saved token
  try {
    await autoUpdater.checkForUpdates()
  } catch (err: any) {
    console.error('[updater] check failed:', err.message)
    sendStatus({ state: 'error', message: err.message || String(err) })
  }
}

export async function downloadUpdate() {
  applyGitHubToken() // ensure token is current before download
  try {
    await autoUpdater.downloadUpdate()
  } catch (err: any) {
    console.error('[updater] download failed:', err.message)
    sendStatus({ state: 'error', message: err.message || String(err) })
  }
}

export function installUpdate() {
  autoUpdater.quitAndInstall(false, true)
}
