import React, { useState, useEffect } from 'react'
import { useTheme } from '../../ThemeContext'
import { api } from '../../lib/api'
import type { ProviderId, ProviderConfig } from '../../../shared/types'
import { PROVIDER_CONFIGS } from '../../../shared/types'

const PROVIDER_IDS: ProviderId[] = ['claude', 'copilot', 'openai', 'gemini']

export default function ProviderSection({
  defaultProvider,
  onDefaultChange,
}: {
  defaultProvider: ProviderId
  onDefaultChange: (id: ProviderId) => void
}) {
  const { colors, fonts } = useTheme()
  const [availability, setAvailability] = useState<Record<ProviderId, { available: boolean; error?: string }> | null>(null)
  const [detecting, setDetecting] = useState(false)
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({})
  const [savedKeys, setSavedKeys] = useState<Record<string, boolean>>({})

  // Detect providers on mount
  useEffect(() => {
    detect()
    // Check which providers have saved keys
    Promise.all(
      (['openai', 'gemini'] as ProviderId[]).map(async (id) => {
        const has = await api.hasProviderApiKey(id)
        return [id, has] as const
      })
    ).then(results => {
      const map: Record<string, boolean> = {}
      for (const [id, has] of results) map[id] = has
      setSavedKeys(map)
    })
  }, [])

  const detect = async () => {
    setDetecting(true)
    try {
      const result = await api.detectProviders()
      setAvailability(result)
    } catch (err) {
      console.error('Provider detection failed:', err)
    } finally {
      setDetecting(false)
    }
  }

  const handleSaveKey = async (provider: ProviderId) => {
    const key = apiKeys[provider]?.trim()
    if (!key) return
    await api.setProviderApiKey(provider, key)
    setSavedKeys(prev => ({ ...prev, [provider]: true }))
    setApiKeys(prev => ({ ...prev, [provider]: '' }))
  }

  return (
    <div>
      {/* Default provider dropdown */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '10px 16px',
      }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 500, color: colors.text, marginBottom: 2 }}>
            Default Provider
          </div>
          <div style={{ fontSize: 11, color: colors.textMuted, lineHeight: 1.4 }}>
            Used when creating new agents.
          </div>
        </div>
        <select
          value={defaultProvider}
          onChange={e => onDefaultChange(e.target.value as ProviderId)}
          style={{
            background: colors.bgOverlay,
            color: colors.text,
            border: `1px solid ${colors.border}`,
            borderRadius: 6,
            padding: '4px 8px',
            fontSize: 12,
            fontFamily: fonts.mono,
            outline: 'none',
            cursor: 'pointer',
          }}
        >
          {PROVIDER_IDS.map(id => (
            <option key={id} value={id}>
              {PROVIDER_CONFIGS[id].displayName}
            </option>
          ))}
        </select>
      </div>

      {/* Provider list */}
      <div style={{ padding: '4px 16px 8px' }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          marginBottom: 8,
        }}>
          <span style={{
            fontSize: 10, fontWeight: 600, color: colors.textMuted,
            textTransform: 'uppercase', letterSpacing: '0.5px',
          }}>
            Availability
          </span>
          <span
            onClick={detect}
            style={{
              fontSize: 10, color: colors.blue, cursor: 'pointer',
              opacity: detecting ? 0.5 : 1,
            }}
          >
            {detecting ? 'Detecting...' : 'Refresh'}
          </span>
        </div>

        {PROVIDER_IDS.map(id => {
          const config = PROVIDER_CONFIGS[id]
          const status = availability?.[id]
          const isAvailable = status?.available ?? false
          const needsKey = config.authType === 'api-key'

          return (
            <div key={id} style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '6px 0',
              borderBottom: `1px solid ${colors.border}08`,
            }}>
              {/* Availability dot */}
              <span style={{
                width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                background: availability === null ? colors.textMuted
                  : isAvailable ? colors.green : `${colors.textMuted}60`,
                transition: 'background 0.2s',
              }} />

              {/* Provider name + badge */}
              <span style={{
                fontSize: 12, fontWeight: 500, color: colors.text,
                flex: 1,
              }}>
                {config.displayName}
              </span>

              {/* Short label pill */}
              <span style={{
                fontSize: 9, fontWeight: 700,
                padding: '1px 6px', borderRadius: 3,
                background: `${config.color}15`,
                color: config.color,
                letterSpacing: '0.3px',
              }}>
                {config.shortLabel}
              </span>

              {/* Status text */}
              <span style={{
                fontSize: 10, color: colors.textMuted, minWidth: 50,
                textAlign: 'right',
              }}>
                {availability === null ? '...'
                  : isAvailable ? 'Ready'
                  : 'Not found'}
              </span>
            </div>
          )
        })}
      </div>

      {/* API key inputs for providers that need them */}
      {(['openai', 'gemini'] as ProviderId[]).map(id => {
        const config = PROVIDER_CONFIGS[id]
        const envVar = id === 'openai' ? 'OPENAI_API_KEY' : 'GEMINI_API_KEY'

        return (
          <div key={id} style={{ padding: '6px 16px' }}>
            <div style={{
              fontSize: 11, fontWeight: 500, color: colors.text,
              marginBottom: 4,
            }}>
              {config.displayName} API Key
              {savedKeys[id] && (
                <span style={{
                  fontSize: 9, color: colors.green, marginLeft: 6,
                  fontWeight: 600,
                }}>
                  Saved
                </span>
              )}
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                type="password"
                placeholder={savedKeys[id] ? '••••••••' : envVar}
                value={apiKeys[id] || ''}
                onChange={e => setApiKeys(prev => ({ ...prev, [id]: e.target.value }))}
                style={{
                  flex: 1,
                  padding: '5px 8px',
                  fontSize: 11,
                  fontFamily: fonts.mono,
                  background: colors.bgOverlay,
                  color: colors.text,
                  border: `1px solid ${colors.border}`,
                  borderRadius: 6,
                  outline: 'none',
                }}
                onKeyDown={e => { if (e.key === 'Enter') handleSaveKey(id) }}
              />
              <button
                onClick={() => handleSaveKey(id)}
                disabled={!apiKeys[id]?.trim()}
                style={{
                  padding: '4px 10px',
                  fontSize: 11,
                  fontWeight: 600,
                  background: apiKeys[id]?.trim() ? colors.blue : colors.bgOverlay,
                  color: apiKeys[id]?.trim() ? '#fff' : colors.textMuted,
                  border: 'none',
                  borderRadius: 6,
                  cursor: apiKeys[id]?.trim() ? 'pointer' : 'not-allowed',
                }}
              >
                Save
              </button>
            </div>
            <div style={{
              fontSize: 10, color: colors.textMuted, marginTop: 3,
            }}>
              Encrypted at rest. Or set {envVar} in your environment.
            </div>
          </div>
        )
      })}
    </div>
  )
}
