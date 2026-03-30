import React, { useEffect, useRef } from 'react'
import { useTheme } from '../../ThemeContext'
import { useSettings } from '../../hooks/useSettings'
import ProviderSection from './ProviderSection'
import UpdateSection from './UpdateSection'

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

      {/* Layout section */}
      {/* Layout picker commented out — grid mode disabled for now */}
      {/*
      <div style={{ borderTop: `1px solid ${colors.border}` }}>
        <div style={{
          padding: '8px 16px 4px',
          fontSize: 10,
          fontWeight: 600,
          color: colors.textMuted,
          textTransform: 'uppercase',
          letterSpacing: '0.5px',
        }}>
          Layout
        </div>
        <div style={{ padding: '6px 16px 10px', display: 'flex', gap: 6 }}>
          {(['grid', 'tabs'] as const).map(mode => (
            <div
              key={mode}
              onClick={() => update({ layoutMode: mode })}
              style={{
                flex: 1,
                padding: '6px 0',
                textAlign: 'center',
                fontSize: 11,
                fontWeight: settings.layoutMode === mode ? 600 : 400,
                color: settings.layoutMode === mode ? colors.text : colors.textMuted,
                background: settings.layoutMode === mode ? `${colors.blue}12` : 'transparent',
                border: `1px solid ${settings.layoutMode === mode ? colors.blue + '40' : colors.border}`,
                borderRadius: 6,
                cursor: 'pointer',
                transition: 'all 0.15s ease',
              }}
            >
              {mode === 'grid' ? 'Grid' : 'Tabs'}
            </div>
          ))}
        </div>
      </div>
      */}

      {/* Updates section */}
      <div style={{ borderTop: `1px solid ${colors.border}` }}>
        <div style={{
          padding: '8px 16px 4px',
          fontSize: 10,
          fontWeight: 600,
          color: colors.textMuted,
          textTransform: 'uppercase',
          letterSpacing: '0.5px',
        }}>
          Updates
        </div>
        <UpdateSection />
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
