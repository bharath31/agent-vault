import type React from 'react'
import { AbsoluteFill } from 'remotion'
import { brand } from '../content'
import { Seal } from './Seal'
import { display, mono, sans } from './fonts'

const c = brand.colors

export const Banner: React.FC = () => {
  return (
    <AbsoluteFill
      style={{
        backgroundColor: c.paper,
        backgroundImage: `radial-gradient(900px 420px at 100% -20%, ${hexA(c.seal, 0.08)}, transparent 70%)`,
        padding: '72px 88px',
        justifyContent: 'space-between',
      }}
    >
      {/* wordmark */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <Seal size={40} color={c.seal} />
        <span
          style={{
            fontFamily: display,
            fontWeight: 600,
            fontSize: 32,
            color: c.ink,
            letterSpacing: '-0.02em',
          }}
        >
          nominee
        </span>
      </div>

      {/* headline */}
      <div style={{ maxWidth: 1180 }}>
        <div
          style={{
            fontFamily: display,
            fontWeight: 600,
            fontSize: 56,
            lineHeight: 1.05,
            letterSpacing: '-0.035em',
            color: c.ink,
          }}
        >
          {brand.taglineFull}
        </div>
        <div
          style={{
            fontFamily: sans,
            fontSize: 23,
            lineHeight: 1.5,
            color: c.muted,
            marginTop: 18,
            maxWidth: 980,
          }}
        >
          {brand.subhead}
        </div>
      </div>

      {/* footer row: proof chip + layer hint */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span
          style={{
            fontFamily: mono,
            fontSize: 22,
            color: c.seal,
            border: `1px solid ${hexA(c.seal, 0.28)}`,
            background: hexA(c.seal, 0.06),
            borderRadius: 10,
            padding: '9px 16px',
          }}
        >
          naive refresh 7/8 fail → nominee 8/8
        </span>
        <span style={{ fontFamily: mono, fontSize: 18, color: c.inkSoft }}>
          framework → nominee → vault
        </span>
      </div>
    </AbsoluteFill>
  )
}

function hexA(hex: string, a: number) {
  const h = hex.replace('#', '')
  const r = Number.parseInt(h.slice(0, 2), 16)
  const g = Number.parseInt(h.slice(2, 4), 16)
  const b = Number.parseInt(h.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${a})`
}
