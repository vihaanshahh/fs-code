import React from 'react'
import { useTheme } from '../../ThemeContext'

export default function AddAgentButton({
  onClick,
  floating = true,
}: {
  onClick: () => void
  floating?: boolean
}) {
  const { colors } = useTheme()

  return (
    <div
      onClick={onClick}
      style={{
        position: 'absolute',
        top: 10,
        right: 10,
        width: 36,
        height: 36,
        borderRadius: '50%',
        background: colors.bgSurface,
        border: `1px solid ${colors.borderMuted}`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        zIndex: 10,
        transition: 'border-color 0.15s ease, background 0.15s ease',
        boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
      }}
      onMouseEnter={e => {
        e.currentTarget.style.borderColor = colors.blue
        e.currentTarget.style.background = `${colors.blue}15`
      }}
      onMouseLeave={e => {
        e.currentTarget.style.borderColor = colors.borderMuted
        e.currentTarget.style.background = colors.bgSurface
      }}
      title="New Agent (Cmd+N)"
    >
      <span style={{ fontSize: 18, color: colors.textSecondary, lineHeight: 1 }}>+</span>
    </div>
  )
}
