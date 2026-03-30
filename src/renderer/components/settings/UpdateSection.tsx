import React, { useState, useEffect } from 'react'
import { useTheme } from '../../ThemeContext'
import { useUpdateStatus } from '../../hooks/useUpdateStatus'
import { api } from '../../lib/api'

// Read version from package.json (bundled by vite)
const APP_VERSION = __APP_VERSION__

declare const __APP_VERSION__: string

export default function UpdateSection() {
  const { colors, fonts } = useTheme()
  const { status, check, download, install } = useUpdateStatus()

  // GitHub token state
  const [hasToken, setHasToken] = useState(false)
  const [tokenInput, setTokenInput] = useState('')
  const [showTokenField, setShowTokenField] = useState(false)
  const [tokenSaved, setTokenSaved] = useState(false)

  useEffect(() => {
    api.hasGitHubToken().then(setHasToken)
  }, [])

  const saveToken = async () => {
    if (!tokenInput.trim()) return
    await api.setGitHubToken(tokenInput.trim())
    setHasToken(true)
    setTokenInput('')
    setShowTokenField(false)
    setTokenSaved(true)
    setTimeout(() => setTokenSaved(false), 2000)
  }

  const removeToken = async () => {
    await api.removeGitHubToken()
    setHasToken(false)
    setShowTokenField(false)
  }

  const buttonStyle: React.CSSProperties = {
    background: 'none',
    border: `1px solid ${colors.blue}60`,
    color: colors.blue,
    borderRadius: 6,
    padding: '4px 12px',
    fontSize: 11,
    fontWeight: 600,
    cursor: 'pointer',
  }

  const smallButton: React.CSSProperties = {
    background: 'none',
    border: `1px solid ${colors.border}`,
    color: colors.textMuted,
    borderRadius: 4,
    padding: '2px 8px',
    fontSize: 10,
    cursor: 'pointer',
  }

  return (
    <div style={{ padding: '6px 16px 10px' }}>
      {/* Current version */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 8,
      }}>
        <span style={{ fontSize: 12, color: colors.textSecondary }}>
          Version <span style={{ fontFamily: fonts.mono, fontWeight: 600 }}>{APP_VERSION}</span>
        </span>
      </div>

      {/* GitHub token for private repo — shown above status */}
      <div style={{ marginBottom: 8 }}>
        {hasToken && !showTokenField ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 11, color: colors.green }}>
              GitHub token configured
            </span>
            {tokenSaved && (
              <span style={{ fontSize: 10, color: colors.green }}>Saved!</span>
            )}
            <button onClick={() => setShowTokenField(true)} style={smallButton}>Change</button>
            <button onClick={removeToken} style={{ ...smallButton, color: colors.red, borderColor: `${colors.red}40` }}>Remove</button>
          </div>
        ) : !showTokenField ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 11, color: colors.textMuted }}>
              Private repo — token required
            </span>
            <button onClick={() => setShowTokenField(true)} style={smallButton}>
              Set Token
            </button>
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <input
              type="password"
              placeholder="ghp_... or github_pat_..."
              value={tokenInput}
              onChange={e => setTokenInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && saveToken()}
              autoFocus
              style={{
                flex: 1,
                background: `${colors.bg}`,
                border: `1px solid ${colors.border}`,
                color: colors.text,
                borderRadius: 4,
                padding: '3px 8px',
                fontSize: 11,
                fontFamily: fonts.mono,
                outline: 'none',
              }}
            />
            <button
              onClick={saveToken}
              style={{ ...smallButton, color: colors.green, borderColor: `${colors.green}60` }}
            >Save</button>
            <button
              onClick={() => { setShowTokenField(false); setTokenInput('') }}
              style={smallButton}
            >Cancel</button>
          </div>
        )}
      </div>

      {/* Status-dependent content */}
      {!status && (
        <button onClick={check} style={buttonStyle}>
          Check for Updates
        </button>
      )}

      {status?.state === 'checking' && (
        <span style={{ fontSize: 12, color: colors.textMuted }}>Checking for updates...</span>
      )}

      {status?.state === 'not-available' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 12, color: colors.green }}>Up to date</span>
          <button onClick={check} style={{ ...buttonStyle, border: `1px solid ${colors.border}`, color: colors.textMuted }}>
            Recheck
          </button>
        </div>
      )}

      {status?.state === 'available' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 12, color: colors.amber }}>
            v{status.version} available
          </span>
          <button onClick={download} style={{ ...buttonStyle, borderColor: `${colors.green}60`, color: colors.green }}>
            Download &amp; Install
          </button>
        </div>
      )}

      {status?.state === 'downloading' && (
        <div>
          <div style={{ fontSize: 12, color: colors.textSecondary, marginBottom: 4 }}>
            Downloading... {status.percent}%
          </div>
          <div style={{
            height: 4,
            background: `${colors.border}`,
            borderRadius: 2,
            overflow: 'hidden',
          }}>
            <div style={{
              width: `${status.percent}%`,
              height: '100%',
              background: colors.blue,
              borderRadius: 2,
              transition: 'width 0.3s ease',
            }} />
          </div>
        </div>
      )}

      {status?.state === 'downloaded' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 12, color: colors.green }}>
            v{status.version} ready to install
          </span>
          <button onClick={install} style={{ ...buttonStyle, background: colors.green, border: 'none', color: '#fff' }}>
            Restart &amp; Update
          </button>
        </div>
      )}

      {status?.state === 'error' && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12, color: colors.red, flex: 1 }}>
              {status.message.length > 60 ? status.message.slice(0, 60) + '...' : status.message}
            </span>
            <button onClick={check} style={{ ...buttonStyle, borderColor: `${colors.red}60`, color: colors.red }}>
              Retry
            </button>
          </div>
          {!hasToken && status.message.includes('404') && (
            <div style={{ fontSize: 10, color: colors.textMuted, marginTop: 4 }}>
              This is a private repo — set a GitHub token above to enable updates.
            </div>
          )}
        </div>
      )}
    </div>
  )
}
