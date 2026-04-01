/**
 * Vite config for the Tauri renderer build.
 *
 * Differences from electron.vite.config.ts renderer section:
 * - VITE_TAURI=true → api.ts uses the tauri-api-shim instead of window.api
 * - Output goes to out/renderer (same dir so tauri.conf.json frontendDist works)
 * - No Electron-specific externals
 * - Dev server runs on port 5173 (matches tauri.conf.json devUrl)
 */
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'
import pkg from './package.json'

export default defineConfig({
  plugins: [react()],
  root: resolve('src/renderer'),
  resolve: {
    alias: {
      // Swap api.ts → tauri-api-shim.ts for the Tauri renderer build.
      // This means all renderer code that does `import { api } from '../lib/api'`
      // gets the Tauri invoke/listen shim instead of window.api — zero component changes.
      './lib/api': resolve('src/renderer/lib/tauri-api-shim.ts'),
      '../lib/api': resolve('src/renderer/lib/tauri-api-shim.ts'),
      '../../lib/api': resolve('src/renderer/lib/tauri-api-shim.ts'),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    'import.meta.env.VITE_TAURI': JSON.stringify(true),
  },
  build: {
    outDir: resolve('out/renderer'),
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      input: resolve('src/renderer/index.html'),
      output: {
        manualChunks: {
          'xterm': ['@xterm/xterm', '@xterm/addon-fit', '@xterm/addon-web-links'],
          'shaders': ['shaders/react'],
        }
      }
    }
  }
})
