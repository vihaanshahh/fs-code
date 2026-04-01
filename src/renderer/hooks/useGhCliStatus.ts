import { useState, useEffect } from 'react'
import type { GhCliStatus } from '../../shared/types'
import { api } from '../lib/api'

let cachedStatus: GhCliStatus | null = null

export function useGhCliStatus(): GhCliStatus | null {
  const [status, setStatus] = useState<GhCliStatus | null>(cachedStatus)

  useEffect(() => {
    if (cachedStatus) return
    api.ghCliStatus().then((s) => {
      cachedStatus = s
      setStatus(s)
    }).catch((err) => {
      console.warn('[useGhCliStatus] failed:', err)
    })
  }, [])

  return status
}
