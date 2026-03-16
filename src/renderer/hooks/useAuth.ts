import { useState, useEffect, useCallback, useRef } from 'react'
import { api } from '../lib/api'
import type { AuthStatus } from '../../shared/types'

export function useAuth() {
  const [status, setStatus] = useState<AuthStatus>({ authenticated: false })
  const [loading, setLoading] = useState(true)
  const autoLoginAttempted = useRef(false)

  // Check auth on mount — retries up to 3 times if CLI not found (Windows cold-start)
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      let s: AuthStatus = { authenticated: false }
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          s = await api.authStatus()
        } catch {
          s = { authenticated: false, error: 'Could not check auth' }
        }
        if (cancelled) return
        if (!s.error?.includes('not found')) break
        if (attempt < 2) await new Promise(r => setTimeout(r, 2000 * (attempt + 1)))
      }
      if (cancelled) return
      setStatus(s)

      // Auto-trigger login if not authenticated and CLI exists
      if (!s.authenticated && !s.error?.includes('not found') && !autoLoginAttempted.current) {
        autoLoginAttempted.current = true
        try {
          const loginResult: AuthStatus = await api.authLogin()
          if (!cancelled) setStatus(loginResult)
        } catch {
          if (!cancelled) setStatus({ authenticated: false, error: 'Login failed' })
        }
      }
      if (!cancelled) setLoading(false)
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
