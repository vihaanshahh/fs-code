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
        input: {
          index: resolve('src/main/index.ts'),
          'indexer-worker': resolve('src/main/codex/indexer-worker.ts'),
        },
        output: {
          // Keep the worker as a standalone file (no code-splitting into shared chunks)
          // so worker_threads can load it directly.
          manualChunks: undefined,
        },
        external: [
          '@anthropic-ai/claude-agent-sdk',
          'electron-updater',
          'better-sqlite3',
          'tree-sitter',
          'tree-sitter-typescript',
          'tree-sitter-typescript/typescript',
          'tree-sitter-typescript/tsx',
          'tree-sitter-javascript',
          'tree-sitter-python',
          'tree-sitter-rust',
          'tree-sitter-go',
          'tree-sitter-bash',
          'tree-sitter-c',
          'tree-sitter-cpp',
          'tree-sitter-json',
          'tree-sitter-css',
          'tree-sitter-html',
          'chokidar',
        ]
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
