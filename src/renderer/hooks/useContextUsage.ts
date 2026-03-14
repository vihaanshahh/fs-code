import { useState, useEffect, useRef } from 'react'
import { api } from '../lib/api'

interface ContextUsage {
  /** Usage percentage (0–100) — real from API if available, else estimated from tokens */
  percent: number
  /** When the limit resets (epoch ms), or null */
  resetsAt: number | null
  /** Human-readable reset time */
  resetsLabel: string | null
  /** Rate limit type (five_hour, seven_day, etc.) */
  limitType: string
  /** Status: allowed, allowed_warning, rejected */
  status: string
  /** Total cost in USD across all agents this session */
  totalCost: number
  /** Whether we've received real usage data from the API */
  hasRealData: boolean
  /** Total tokens used this session */
  totalTokens: number
}

function formatResetTime(resetsAt: number | null): string | null {
  if (!resetsAt) return null
  const diff = resetsAt - Date.now()
  if (diff <= 0) return 'now'
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  const remainMins = mins % 60
  return remainMins > 0 ? `${hrs}h ${remainMins}m` : `${hrs}h`
}

// Rough 5-hour window token budget for Pro plan (~45M tokens / 5hr based on typical limits)
const ESTIMATED_TOKEN_BUDGET = 45_000_000

/**
 * Tracks real API usage from rate_limit_event messages + total session cost.
 * Falls back to token-count estimation when real utilization data hasn't arrived yet.
 */
export function useContextUsage(): ContextUsage {
  const [usage, setUsage] = useState<ContextUsage>({
    percent: 0,
    resetsAt: null,
    resetsLabel: null,
    limitType: '',
    status: 'allowed',
    totalCost: 0,
    hasRealData: false,
    totalTokens: 0,
  })

  // Accumulate tokens for fallback estimation
  const totalTokens = useRef(0)

  useEffect(() => {
    const unsub = api.onAgentMessage((data: any) => {
      // Debug: log usage-related messages
      if (data.type === 'usage' || data.type === 'token-usage' || data.type === 'result') {
        console.log(`[useContextUsage] ${data.type}:`, data.type === 'usage' ? `util=${data.utilization}` : data.type === 'token-usage' ? `in=${data.inputTokens} out=${data.outputTokens}` : `cost=${data.cost}`)
      }
      // Track real usage from rate_limit_event → usage messages
      if (data.type === 'usage' && typeof data.utilization === 'number') {
        const newPercent = Math.round(data.utilization * 100)
        setUsage(prev => {
          if (prev.percent === newPercent && prev.resetsAt === data.resetsAt &&
              prev.status === (data.status || prev.status)) return prev
          return {
            ...prev,
            percent: newPercent,
            resetsAt: data.resetsAt,
            resetsLabel: formatResetTime(data.resetsAt),
            limitType: data.limitType || prev.limitType,
            status: data.status || prev.status,
            hasRealData: true,
          }
        })
      }
      // Track token usage
      if (data.type === 'token-usage') {
        const tokens = (data.inputTokens || 0) + (data.outputTokens || 0)
        if (tokens === 0) return
        totalTokens.current += tokens
        setUsage(prev => {
          const newPercent = prev.hasRealData
            ? prev.percent
            : Math.min(99, Math.round((totalTokens.current / ESTIMATED_TOKEN_BUDGET) * 100))
          if (prev.totalTokens === totalTokens.current && prev.percent === newPercent) return prev
          return { ...prev, totalTokens: totalTokens.current, percent: newPercent }
        })
      }
      // Track total cost from result messages
      if (data.type === 'result' && typeof data.cost === 'number') {
        if (data.cost === 0) return
        setUsage(prev => ({
          ...prev,
          totalCost: prev.totalCost + data.cost,
        }))
      }
    })
    return unsub
  }, [])

  // Update reset label periodically
  useEffect(() => {
    if (!usage.resetsAt) return
    const interval = setInterval(() => {
      setUsage(prev => ({
        ...prev,
        resetsLabel: formatResetTime(prev.resetsAt),
      }))
    }, 30000) // update every 30s
    return () => clearInterval(interval)
  }, [usage.resetsAt])

  return usage
}
