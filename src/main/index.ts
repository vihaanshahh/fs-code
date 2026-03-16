import { app, BrowserWindow, shell, dialog, nativeImage, Menu } from 'electron'
import { join, resolve } from 'node:path'
import { IPC } from '../shared/types'

// Set app name before anything else
app.name = 'FluidState'
if (process.platform === 'darwin') {
  app.setName('FluidState')
}

// Catch unhandled errors
process.on('uncaughtException', (err) => {
  console.error('[main] uncaughtException:', err)
  try { dialog.showErrorBox('FluidState Error', err.message + '\n\n' + err.stack) } catch {}
})
process.on('unhandledRejection', (err: any) => {
  console.error('[main] unhandledRejection:', err)
})

let mainWindow: BrowserWindow | null = null

// ── Multi-instance support ──────────────────────────────────────────
// Allow multiple FluidState windows/instances to run simultaneously.
// In dev mode we never lock so the production app doesn't block dev.
// In production, a second launch opens a new window in the existing process
// (keeping one Dock icon) but you can also force a fresh process with --new-instance.
const isDev = !!process.env.ELECTRON_RENDERER_URL
const wantNewProcess = process.argv.includes('--new-instance')

if (isDev || wantNewProcess) {
  // Skip the single-instance lock entirely — run as a standalone process
} else {
  const gotLock = app.requestSingleInstanceLock()
  if (!gotLock) {
    // Another production instance is running — tell it to open a new window, then quit
    app.quit()
  } else {
    app.on('second-instance', (_event, argv) => {
      // Extract --open-dir from the second instance's argv
      const openDirArg = argv.find((a: string) => a.startsWith('--open-dir='))
      const dir = openDirArg ? openDirArg.split('=')[1] : null
      // Open a new window instead of just focusing the existing one
      createWindow(dir ? resolve(dir) : null)
    })
  }
}

function createWindow(initialCwd: string | null = null) {
  console.log('[main] creating window...')

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#0d1117',
    icon: join(__dirname, '../../resources/icon.png'),
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

  mainWindow.webContents.on('did-finish-load', () => {
    if (initialCwd && mainWindow) {
      console.log('[main] sending initial cwd:', initialCwd)
      mainWindow.webContents.send(IPC.APP_INITIAL_CWD, initialCwd)
    }
  })

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

  // Set dock icon on macOS
  const iconPath = join(__dirname, '../../resources/icon.png')
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setIcon(nativeImage.createFromPath(iconPath))
  }

  // Read --open-dir flag from CLI launcher
  const initialCwd = app.commandLine.getSwitchValue('open-dir') || null

  // Set custom menu so Electron's default accelerators don't swallow our shortcuts
  const installCLIMenuItem: Electron.MenuItemConstructorOptions = {
    label: "Install 'fluidstate' command in PATH...",
    click: async () => {
      const { installCLI } = await import('./cli-install')
      const result = await installCLI()
      if (result.success) {
        dialog.showMessageBox({
          type: 'info',
          title: 'CLI Installed',
          message: `'fluidstate' command installed successfully`,
          detail: `You can now run 'fluidstate .' from any terminal to open FluidState.\n\nInstalled to: ${result.path}`,
        })
      } else {
        dialog.showMessageBox({
          type: 'error',
          title: 'CLI Installation Failed',
          message: 'Could not install the CLI command',
          detail: result.error || 'Unknown error',
        })
      }
    },
  }

  if (process.platform === 'darwin') {
    const template: Electron.MenuItemConstructorOptions[] = [
      {
        role: 'appMenu',
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          installCLIMenuItem,
          { type: 'separator' },
          { role: 'services' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      { role: 'editMenu' },
      {
        label: 'View',
        submenu: [
          { role: 'reload' },
          { role: 'forceReload' },
          { role: 'toggleDevTools' },
          { type: 'separator' },
          { role: 'togglefullscreen' },
        ],
      },
      {
        label: 'Window',
        submenu: [
          // Cmd+M minimize removed — we use Cmd+Shift+M in the renderer
          { role: 'close' },
        ],
      },
    ]
    Menu.setApplicationMenu(Menu.buildFromTemplate(template))
  } else {
    // Windows/Linux: add CLI install to a Help menu
    const template: Electron.MenuItemConstructorOptions[] = [
      { role: 'editMenu' },
      {
        label: 'View',
        submenu: [
          { role: 'reload' },
          { role: 'forceReload' },
          { role: 'toggleDevTools' },
          { type: 'separator' },
          { role: 'togglefullscreen' },
        ],
      },
      {
        label: 'Help',
        submenu: [installCLIMenuItem],
      },
    ]
    Menu.setApplicationMenu(Menu.buildFromTemplate(template))
  }

  // Create window FIRST so user sees something
  createWindow(initialCwd)

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
    // Wire up keystore → provider factory
    const { setApiKeyGetter } = await import('./providers')
    const keystoreMod = await import('./keystore')
    setApiKeyGetter((provider) => keystoreMod.getApiKey(provider))
    console.log('[main] agent + terminal + providers ready')
  } catch (err: any) {
    console.error('[main] Failed to load agent SDK:', err)
  }

  // Auto-install CLI on first launch (prompts user once, then remembers)
  try {
    const { autoInstallCLI } = await import('./cli-install')
    await autoInstallCLI()
  } catch (err: any) {
    console.warn('[main] CLI auto-install check failed:', err.message)
  }

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
      if (mainWindow) {
        const agentMod = await import('./agent')
        const termMod = await import('./terminal')
        agentMod.setMainWindow(mainWindow)
        termMod.setMainWindow(mainWindow)
      }
    }
  })
})

app.on('window-all-closed', async () => {
  try {
    const terminal = await import('./terminal')
    terminal.closeAll()
  } catch {}
  if (process.platform !== 'darwin') app.quit()
})
