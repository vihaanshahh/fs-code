import { useState, useEffect, useCallback } from 'react'
import type { ProviderId } from '../../shared/types'

const STORAGE_KEY = 'fs-code-settings'

export interface AppSettings {
  /** Enable @ file mentions in the chat input */
  atMentionsEnabled: boolean
  /** Default provider for new agents */
  defaultProvider: ProviderId
}

const DEFAULTS: AppSettings = {
  atMentionsEnabled: true,
  defaultProvider: 'claude',
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
