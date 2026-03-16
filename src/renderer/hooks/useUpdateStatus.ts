import { useState, useEffect } from 'react'
import { api } from '../lib/api'
import type { UpdateStatus } from '../../shared/types'

export function useUpdateStatus() {
  const [status, setStatus] = useState<UpdateStatus | null>(null)

  useEffect(() => {
    return api.onUpdateStatus((data: UpdateStatus) => {
      setStatus(data)
    })
  }, [])

  return {
    status,
    check: () => api.checkForUpdates(),
    download: () => api.downloadUpdate(),
    install: () => api.installUpdate(),
    dismiss: () => setStatus(null),
  }
}
