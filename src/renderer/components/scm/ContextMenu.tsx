import React, { useEffect, useRef } from 'react'
import { useTheme } from '../../ThemeContext'

export interface ContextMenuItem {
  label: string
  onClick: () => void
  danger?: boolean
  separator?: boolean
}

interface ContextMenuProps {
  x: number
  y: number
  items: ContextMenuItem[]
  onClose: () => void
}

export default function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const { colors, fonts } = useTheme()
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', handleClick)
    window.addEventListener('keydown', handleKey)
    return () => {
      window.removeEventListener('mousedown', handleClick)
      window.removeEventListener('keydown', handleKey)
    }
  }, [onClose])

  // Adjust position if menu would go off screen
  const adjustedX = Math.min(x, window.innerWidth - 200)
  const adjustedY = Math.min(y, window.innerHeight - items.length * 32 - 16)

  return (
    <div
      ref={menuRef}
      style={{
        position: 'fixed',
        left: adjustedX,
        top: adjustedY,
        zIndex: 2000,
        background: colors.bgSurface,
        border: `1px solid ${colors.border}`,
        borderRadius: 8,
        padding: '4px 0',
        minWidth: 180,
        boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
        animation: 'modalIn 0.1s ease',
      }}
    >
      {items.map((item, i) =>
        item.separator ? (
          <div key={i} style={{ height: 1, background: colors.border, margin: '4px 0' }} />
        ) : (
          <div
            key={i}
            onClick={() => { item.onClick(); onClose() }}
            style={{
              padding: '6px 14px',
              fontSize: 12,
              fontFamily: fonts.mono,
              color: item.danger ? colors.red : colors.text,
              cursor: 'pointer',
              transition: 'background 0.1s ease',
              userSelect: 'none',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = `${colors.blue}18` }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
          >
            {item.label}
          </div>
        )
      )}
    </div>
  )
}
