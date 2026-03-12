import { useState, useCallback } from 'react'
import { api } from '../lib/api'
import type { FileEntry } from '../../shared/types'

export function useFileTree(rootPath: string) {
  const [tree, setTree] = useState<FileEntry[]>([])
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const entries = await api.readDir(rootPath)
      setTree(entries)
    } catch {}
    setLoading(false)
  }, [rootPath])

  return { tree, loading, refresh }
}
