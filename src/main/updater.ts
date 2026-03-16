/**
 * Auto-updater — wraps electron-updater for GitHub Releases.
 * Uses SHA-512 verification (works without code signing).
 */

import { autoUpdater } from 'electron-updater'
import type { UpdateInfo } from 'electron-updater'
import { app } from 'electron'
import type { BrowserWindow } from 'electron'
import { IPC } from '../shared/types'

let mainWindow: BrowserWindow | null = null

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
}

export async function checkForUpdates() {
  try {
    await autoUpdater.checkForUpdates()
  } catch (err: any) {
    console.error('[updater] check failed:', err.message)
    sendStatus({ state: 'error', message: err.message || String(err) })
  }
}

export async function downloadUpdate() {
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
