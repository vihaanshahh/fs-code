import { useState, useEffect, useRef } from 'react'
import { api } from '../lib/api'

interface UsageLimitData {
  utilization: number | null
  resets_at: string | null
}

interface ExtraUsageData {
  is_enabled: boolean
  monthly_limit: number | null
  used_credits: number | null
  utilization: number | null
}

interface UsageAPIData {
  five_hour?: UsageLimitData
  seven_day?: UsageLimitData
  seven_day_sonnet?: UsageLimitData
  extra_usage?: ExtraUsageData
}

function formatResetTime(resetsAt: string | null): string | null {
  if (!resetsAt) return null
  const diff = new Date(resetsAt).getTime() - Date.now()
  if (diff <= 0) return 'now'
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  const remainMins = mins % 60
  return remainMins > 0 ? `${hrs}h ${remainMins}m` : `${hrs}h`
}

const POLL_INTERVAL = 2 * 60 * 1000 // 2 minutes

/**
 * Polls the Anthropic usage API every 2 minutes.
 * Returns the latest usage data for display in the status bar.
 */
export function useApiUsage() {
  const [data, setData] = useState<UsageAPIData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const fetchRef = useRef<() => Promise<void>>()

  fetchRef.current = async () => {
    try {
      const result: any = await api.fetchUsage()
      if (result.error) {
        setError(result.error)
        return
      }
      setError(null)
      setData(result)
    } catch {
      setError('Failed to fetch')
    }
  }

  useEffect(() => {
    fetchRef.current?.()
    const id = setInterval(() => fetchRef.current?.(), POLL_INTERVAL)
    return () => clearInterval(id)
  }, [])

  // Derived summary for the status bar
  const fiveHour = data?.five_hour
  const sevenDay = data?.seven_day
  const extra = data?.extra_usage

  const sessionPct = fiveHour?.utilization != null ? Math.floor(fiveHour.utilization) : null
  const sessionReset = fiveHour ? formatResetTime(fiveHour.resets_at) : null
  const weekPct = sevenDay?.utilization != null ? Math.floor(sevenDay.utilization) : null
  const extraSpent = extra?.used_credits != null ? (extra.used_credits / 100) : null
  const extraLimit = extra?.monthly_limit != null ? (extra.monthly_limit / 100) : null

  return { data, error, sessionPct, sessionReset, weekPct, extraSpent, extraLimit, refetch: () => fetchRef.current?.() }
}
