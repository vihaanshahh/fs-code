import { useState, useEffect } from 'react'
import { api } from '../lib/api'
import type { ResourceStats } from '../../shared/types'

/**
 * Live resource stats from the main process.
 * Updates every 30s via push from the memory monitor,
 * plus on-demand via pull on mount.
 */
export function useResourceStats(): ResourceStats | null {
  const [stats, setStats] = useState<ResourceStats | null>(null)

  useEffect(() => {
    // Pull on mount
    api.getResourceStats().then(setStats).catch(() => {})

    // Listen for periodic pushes
    const unsub = api.onResourceStats(setStats)
    return unsub
  }, [])

  return stats
}
