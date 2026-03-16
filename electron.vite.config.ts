import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'
import pkg from './package.json'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      minify: true,
      rollupOptions: {
        external: ['@anthropic-ai/claude-agent-sdk', 'electron-updater']
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      minify: true,
    }
  },
  renderer: {
    plugins: [react()],
    root: resolve('src/renderer'),
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
    },
    build: {
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
  }
})
