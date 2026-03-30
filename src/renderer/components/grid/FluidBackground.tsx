import React, { useRef, useEffect, useState } from 'react'
import { Shader, ChromaFlow, Swirl } from 'shaders/react'
import { useTheme } from '../../ThemeContext'

const SHADER_COLORS = {
  light: {
    base: '#e8e8e8',
    baseDown: '#f5f5f5',
    accent: '#4a9eff',
    accentRight: '#6bb6ff',
  },
  dark: {
    base: '#000000',
    baseDown: '#0a0a0a',
    accent: '#1e40af',
    accentRight: '#3b82f6',
  },
}

export default function FluidBackground() {
  const { theme } = useTheme()
  const [ready, setReady] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const colors = SHADER_COLORS[theme] ?? SHADER_COLORS.light

  useEffect(() => {
    const check = () => {
      if (containerRef.current) {
        const canvas = containerRef.current.querySelector('canvas')
        if (canvas && canvas.width > 0 && canvas.height > 0) {
          setReady(true)
          return true
        }
      }
      return false
    }

    if (check()) return

    const interval = setInterval(() => {
      if (check()) clearInterval(interval)
    }, 100)

    const fallback = setTimeout(() => setReady(true), 1500)

    return () => {
      clearInterval(interval)
      clearTimeout(fallback)
    }
  }, [])

  return (
    <div
      key={theme}
      ref={containerRef}
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 0,
        transition: 'opacity 0.7s ease',
        opacity: ready ? 1 : 0,
        contain: 'strict',
      }}
    >
      <Shader style={{ width: '100%', height: '100%' }}>
        <Swirl
          colorA={colors.base}
          colorB={colors.accent}
          speed={0.4}
          detail={0.5}
          blend={50}
        />
        <ChromaFlow
          baseColor={colors.base}
          upColor={colors.base}
          downColor={colors.baseDown}
          leftColor={colors.accent}
          rightColor={colors.accentRight}
          intensity={0.9}
          radius={1.8}
          momentum={25}
          maskType="alpha"
          opacity={theme === 'dark' ? 0.97 : 0.85}
        />
      </Shader>

      {/* Grain overlay */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          pointerEvents: 'none',
          opacity: 0.06,
          backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 400 400' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")`,
        }}
      />
    </div>
  )
}
