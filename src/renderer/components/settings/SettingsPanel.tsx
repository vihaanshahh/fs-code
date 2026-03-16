import React, { useEffect, useRef } from 'react'
import { useTheme } from '../../ThemeContext'
import { useSettings } from '../../hooks/useSettings'
import ProviderSection from './ProviderSection'

function ToggleSwitch({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  const { colors } = useTheme()
  return (
    <div
      onClick={() => onChange(!value)}
      style={{
        width: 36,
        height: 20,
        borderRadius: 10,
        background: value ? colors.blue : `${colors.textMuted}30`,
        cursor: 'pointer',
        position: 'relative',
        transition: 'background 0.2s ease',
        flexShrink: 0,
      }}
    >
      <div style={{
        width: 16,
        height: 16,
        borderRadius: 8,
        background: '#fff',
        position: 'absolute',
        top: 2,
        left: value ? 18 : 2,
        transition: 'left 0.2s ease',
        boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
      }} />
    </div>
  )
}

export default function SettingsPanel({ onClose }: { onClose: () => void }) {
  const { colors, fonts } = useTheme()
  const [settings, update] = useSettings()
  const panelRef = useRef<HTMLDivElement>(null)

  // Close on click outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    // Delay to avoid catching the opening click
    const timer = setTimeout(() => document.addEventListener('mousedown', handler), 50)
    return () => { clearTimeout(timer); document.removeEventListener('mousedown', handler) }
  }, [onClose])

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  return (
    <div
      ref={panelRef}
      style={{
        position: 'absolute',
        top: 40,
        right: 12,
        width: 360,
        maxHeight: 'calc(100vh - 60px)',
        overflowY: 'auto',
        background: colors.bgSurface,
        border: `1px solid ${colors.border}`,
        borderRadius: 12,
        boxShadow: '0 8px 32px rgba(0,0,0,0.2)',
        zIndex: 100,
        overflow: 'hidden',
        animation: 'fadeSlideIn 0.15s ease',
      }}
    >
      {/* Header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '12px 16px 8px',
        borderBottom: `1px solid ${colors.border}`,
      }}>
        <span style={{
          fontSize: 13,
          fontWeight: 700,
          color: colors.text,
        }}>
          Settings
        </span>
        <span
          onClick={onClose}
          style={{
            fontSize: 16,
            color: colors.textMuted,
            cursor: 'pointer',
            lineHeight: 1,
            padding: '0 2px',
          }}
        >
          ×
        </span>
      </div>

      {/* Settings items */}
      <div style={{ padding: '8px 0' }}>
        {/* Section header */}
        <div style={{
          padding: '8px 16px 4px',
          fontSize: 10,
          fontWeight: 600,
          color: colors.textMuted,
          textTransform: 'uppercase',
          letterSpacing: '0.5px',
        }}>
          Input
        </div>

        {/* @ File Mentions toggle */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '10px 16px',
            cursor: 'pointer',
          }}
          onClick={() => update({ atMentionsEnabled: !settings.atMentionsEnabled })}
        >
          <div style={{ flex: 1 }}>
            <div style={{
              fontSize: 13,
              fontWeight: 500,
              color: colors.text,
              marginBottom: 2,
            }}>
              @ File Mentions
            </div>
            <div style={{
              fontSize: 11,
              color: colors.textMuted,
              lineHeight: 1.4,
            }}>
              Type @ to search and attach files as context.
              Disable if causing issues.
            </div>
          </div>
          <ToggleSwitch
            value={settings.atMentionsEnabled}
            onChange={v => update({ atMentionsEnabled: v })}
          />
        </div>
      </div>

      {/* Providers section */}
      <div style={{ borderTop: `1px solid ${colors.border}` }}>
        <div style={{
          padding: '8px 16px 4px',
          fontSize: 10,
          fontWeight: 600,
          color: colors.textMuted,
          textTransform: 'uppercase',
          letterSpacing: '0.5px',
        }}>
          Providers
        </div>
        <ProviderSection
          defaultProvider={settings.defaultProvider}
          onDefaultChange={(id) => update({ defaultProvider: id })}
        />
      </div>

      {/* Footer hint */}
      <div style={{
        padding: '8px 16px 12px',
        borderTop: `1px solid ${colors.border}`,
        fontSize: 10,
        color: colors.textMuted,
        fontFamily: fonts.mono,
      }}>
        Settings saved to localStorage
      </div>
    </div>
  )
}
