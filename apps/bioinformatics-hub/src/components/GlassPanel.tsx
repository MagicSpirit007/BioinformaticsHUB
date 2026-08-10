import type { ReactNode, CSSProperties } from 'react'
import LiquidGlass from 'liquid-glass-react'

type Props = {
  children: ReactNode
  className?: string
  padding?: string
  cornerRadius?: number
  onClick?: () => void
  style?: CSSProperties
  elasticity?: number
  overLight?: boolean
  /** Solid fallback when user prefers reduced transparency */
  solid?: boolean
  /** Single native backdrop surface for fixed/portal UI that must not split into measured layers. */
  nativeMaterial?: boolean
}

export function GlassPanel({
  children,
  className = '',
  padding = '20px',
  cornerRadius = 24,
  onClick,
  style,
  elasticity = 0.18,
  overLight = true,
  solid = false,
  nativeMaterial = false,
}: Props) {
  const reduceTransparency =
    solid ||
    (typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-transparency: reduce)').matches)

  if (nativeMaterial || reduceTransparency) {
    return (
      <div
        className={`glass-wrap ${reduceTransparency ? 'glass-solid' : 'glass-native'} ${className}`}
        style={{ ...style, borderRadius: cornerRadius, padding }}
        onClick={onClick}
        role={onClick ? 'button' : undefined}
      >
        {children}
      </div>
    )
  }

  return (
    <div className={`glass-wrap ${className}`} style={style}>
      <LiquidGlass
        displacementScale={36}
        blurAmount={0.12}
        saturation={112}
        aberrationIntensity={0.65}
        elasticity={elasticity}
        cornerRadius={cornerRadius}
        padding={padding}
        overLight={overLight}
        onClick={onClick}
      >
        {children}
      </LiquidGlass>
    </div>
  )
}
