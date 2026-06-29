import type React from 'react'
import { AbsoluteFill } from 'remotion'
import { brand } from '../content'
import { Seal } from './Seal'
import { display, mono, sans } from './fonts'
import { hexA } from './util'

const c = brand.colors

export const Og: React.FC = () => {
  return (
    <AbsoluteFill
      style={{
        backgroundColor: c.paper,
        backgroundImage: `radial-gradient(800px 500px at 50% -30%, ${hexA(c.seal, 0.08)}, transparent 70%)`,
        padding: '76px 90px',
        justifyContent: 'space-between',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <Seal size={44} color={c.seal} />
        <span
          style={{
            fontFamily: display,
            fontWeight: 600,
            fontSize: 34,
            color: c.ink,
            letterSpacing: '-0.02em',
          }}
        >
          nominee
        </span>
      </div>

      <div>
        <div
          style={{
            fontFamily: display,
            fontWeight: 600,
            fontSize: 62,
            lineHeight: 1.04,
            letterSpacing: '-0.035em',
            color: c.ink,
            maxWidth: 1020,
          }}
        >
          {brand.taglineFull}
        </div>
        <div
          style={{
            fontFamily: sans,
            fontSize: 26,
            lineHeight: 1.45,
            color: c.muted,
            marginTop: 22,
            maxWidth: 940,
          }}
        >
          Framework-neutral, no SaaS.
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span
          style={{
            fontFamily: mono,
            fontSize: 24,
            color: c.seal,
            border: `1px solid ${hexA(c.seal, 0.28)}`,
            background: hexA(c.seal, 0.06),
            borderRadius: 11,
            padding: '10px 18px',
          }}
        >
          naive refresh 7/8 fail → nominee 8/8
        </span>
        <span style={{ fontFamily: mono, fontSize: 20, color: c.inkSoft }}>nominee.dev</span>
      </div>
    </AbsoluteFill>
  )
}
