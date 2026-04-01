import type { API } from '../../preload/index'

declare global {
  interface Window {
    api: API
  }
}

// Electron build: use the contextBridge-exposed window.api.
// Tauri build: vite.tauri.config.ts aliases this file to tauri-api-shim.ts
// so the renderer gets tauriApi instead, with no code changes needed anywhere.
export const api: API = window.api
