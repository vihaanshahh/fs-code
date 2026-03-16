import { useState, useEffect, useCallback } from 'react'
import { api } from '../lib/api'
import type { AuthStatus } from '../../shared/types'

export function useAuth() {
  const [status, setStatus] = useState<AuthStatus>({ authenticated: false })
  const [loading, setLoading] = useState(true)

  // Check auth on mount — retries once after a short delay if CLI not found (Windows cold-start)
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      let s: AuthStatus = { authenticated: false }
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          s = await api.authStatus()
        } catch {
          s = { authenticated: false, error: 'Could not check auth' }
        }
        if (cancelled) return
        if (!s.error?.includes('not found')) break
        // One retry after 2s for Windows cold-start PATH availability
        if (attempt < 1) await new Promise(r => setTimeout(r, 2000))
      }
      if (!cancelled) {
        setStatus(s)
        setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [])

  const login = useCallback(async () => {
    setLoading(true)
    try {
      const s: AuthStatus = await api.authLogin()
      setStatus(s)
    } catch {
      setStatus({ authenticated: false, error: 'Login failed' })
    } finally {
      setLoading(false)
    }
  }, [])

  const logout = useCallback(async () => {
    setLoading(true)
    try {
      const s: AuthStatus = await api.authLogout()
      setStatus(s)
    } catch {
      setStatus({ authenticated: false, error: 'Logout failed' })
    } finally {
      setLoading(false)
    }
  }, [])

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const s: AuthStatus = await api.authStatus()
      setStatus(s)
    } catch {
      setStatus({ authenticated: false, error: 'Could not check auth' })
    } finally {
      setLoading(false)
    }
  }, [])

  return { status, loading, login, logout, refresh }
}
