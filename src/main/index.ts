import { app, BrowserWindow, shell, dialog } from 'electron'
import { join } from 'node:path'

// Catch unhandled errors
process.on('uncaughtException', (err) => {
  console.error('[main] uncaughtException:', err)
  try { dialog.showErrorBox('FS Code Error', err.message + '\n\n' + err.stack) } catch {}
})
process.on('unhandledRejection', (err: any) => {
  console.error('[main] unhandledRejection:', err)
})

let mainWindow: BrowserWindow | null = null

function createWindow() {
  console.log('[main] creating window...')

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#0d1117',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 12, y: 12 } } : {}),
    show: true, // Show immediately — no waiting
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  // Open devtools in dev mode
  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  }

  // Open external links in browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  // Load the renderer
  const rendererUrl = process.env.ELECTRON_RENDERER_URL
  console.log('[main] loading renderer:', rendererUrl || 'file')

  if (rendererUrl) {
    mainWindow.loadURL(rendererUrl)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.webContents.on('did-fail-load', (_e, code, desc) => {
    console.error('[main] renderer failed to load:', code, desc)
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  console.log('[main] window created')
}

app.whenReady().then(async () => {
  console.log('[main] app ready, pid:', process.pid)

  // Create window FIRST so user sees something
  createWindow()

  // Then set up IPC and SDK (can fail without killing the window)
  try {
    const { registerIpcHandlers } = await import('./ipc')
    registerIpcHandlers()
    console.log('[main] IPC handlers registered')
  } catch (err: any) {
    console.error('[main] Failed to register IPC:', err)
  }

  try {
    const agent = await import('./agent')
    const terminal = await import('./terminal')
    if (mainWindow) {
      agent.setMainWindow(mainWindow)
      terminal.setMainWindow(mainWindow)
    }
    console.log('[main] agent + terminal ready')
  } catch (err: any) {
    console.error('[main] Failed to load agent SDK:', err)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', async () => {
  try {
    const terminal = await import('./terminal')
    terminal.closeAll()
  } catch {}
  if (process.platform !== 'darwin') app.quit()
})
