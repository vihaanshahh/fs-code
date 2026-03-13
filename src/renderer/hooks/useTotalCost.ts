import { useState, useEffect } from 'react'
import { api } from '../lib/api'

// Tracks total cost across all agents by listening to result messages
export function useTotalCost(): number {
  const [totalCost, setTotalCost] = useState(0)

  useEffect(() => {
    const unsub = api.onAgentMessage((data: any) => {
      if (data.type === 'result' && typeof data.cost === 'number') {
        setTotalCost(prev => prev + data.cost)
      }
    })
    return unsub
  }, [])

  return totalCost
}
