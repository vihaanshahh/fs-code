import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { api } from '../lib/api'
import type { GitFileStatus } from '../../shared/types'

export function useSourceControl(cwd: string | undefined, visible: boolean) {
  const [files, setFiles] = useState<GitFileStatus[]>([])
  const [loading, setLoading] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const mountedRef = useRef(true)

  const refresh = useCallback(() => setRefreshKey(k => k + 1), [])

  // Fetch detailed status
  useEffect(() => {
    if (!cwd || !visible) return
    mountedRef.current = true

    const fetchStatus = async () => {
      setLoading(true)
      try {
        const result = await api.gitStatusDetailed(cwd)
        if (mountedRef.current) setFiles(result?.files || [])
      } catch {
        if (mountedRef.current) setFiles([])
      } finally {
        if (mountedRef.current) setLoading(false)
      }
    }

    fetchStatus()

    // Poll every 15 seconds (was 3s — excessive git process spawning)
    const interval = setInterval(fetchStatus, 15000)
    return () => {
      mountedRef.current = false
      clearInterval(interval)
    }
  }, [cwd, visible, refreshKey])

  // Derived categories
  const stagedFiles = useMemo(() => files.filter(f => f.category === 'staged'), [files])
  const unstagedFiles = useMemo(() => files.filter(f => f.category === 'unstaged'), [files])
  const untrackedFiles = useMemo(() => files.filter(f => f.category === 'untracked'), [files])

  const totalChanges = files.length

  const stage = useCallback(async (path: string) => {
    if (!cwd) return
    await api.gitStage(path, cwd)
    refresh()
  }, [cwd, refresh])

  const unstage = useCallback(async (path: string) => {
    if (!cwd) return
    await api.gitUnstage(path, cwd)
    refresh()
  }, [cwd, refresh])

  const stageAll = useCallback(async () => {
    if (!cwd) return
    const toStage = [...unstagedFiles, ...untrackedFiles]
    await Promise.all(toStage.map(f => api.gitStage(f.path, cwd)))
    refresh()
  }, [cwd, unstagedFiles, untrackedFiles, refresh])

  const unstageAll = useCallback(async () => {
    if (!cwd) return
    await Promise.all(stagedFiles.map(f => api.gitUnstage(f.path, cwd)))
    refresh()
  }, [cwd, stagedFiles, refresh])

  const discard = useCallback(async (path: string) => {
    if (!cwd) return
    await api.gitDiscard(path, cwd)
    refresh()
  }, [cwd, refresh])

  const commit = useCallback(async (message: string) => {
    if (!cwd) return { success: false, error: 'No working directory' }
    const result = await api.gitCommit(message, cwd)
    refresh()
    return result
  }, [cwd, refresh])

  return {
    files,
    stagedFiles,
    unstagedFiles,
    untrackedFiles,
    totalChanges,
    loading,
    stage,
    unstage,
    stageAll,
    unstageAll,
    discard,
    commit,
    refresh,
  }
}
