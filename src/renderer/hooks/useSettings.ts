import { useState, useEffect, useCallback } from 'react'
import type { ProviderId } from '../../shared/types'

const STORAGE_KEY = 'fs-code-settings'

export interface AppSettings {
  /** Default provider for new agents */
  defaultProvider: ProviderId
  /** Layout mode: grid (split panes) or tabs (single agent with tab bar) */
  layoutMode: 'grid' | 'tabs'
}

const DEFAULTS: AppSettings = {
  defaultProvider: 'claude',
  layoutMode: 'tabs',
}

function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      return { ...DEFAULTS, ...JSON.parse(raw) }
    }
  } catch { /* ignore */ }
  return { ...DEFAULTS }
}

function saveSettings(settings: AppSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
}

// Simple global listener pattern so multiple consumers stay in sync
const listeners = new Set<() => void>()
let currentSettings = loadSettings()

export function useSettings(): [AppSettings, (patch: Partial<AppSettings>) => void] {
  const [settings, setSettings] = useState<AppSettings>(currentSettings)

  useEffect(() => {
    const handler = () => setSettings({ ...currentSettings })
    listeners.add(handler)
    return () => { listeners.delete(handler) }
  }, [])

  const update = useCallback((patch: Partial<AppSettings>) => {
    currentSettings = { ...currentSettings, ...patch }
    saveSettings(currentSettings)
    listeners.forEach(fn => fn())
  }, [])

  return [settings, update]
}
