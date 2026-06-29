import type React from 'react'
import { AbsoluteFill, Easing, interpolate, useCurrentFrame } from 'remotion'
import { brand } from '../content'
import { Seal } from './Seal'
import { display, mono } from './fonts'
import { hexA } from './util'

const c = brand.colors
const term = { bg: '#0b1226', line: 'rgba(214,224,245,0.10)', text: '#cdd5e6', dim: '#8b96ad' }
const RED = '#e2675d'
const GREEN = '#56b487'

type Row = { label: string; result: string; tone: 'ok' | 'bad' | 'dim' }
const rows: Row[] = [
  { label: '$ node run.mjs', result: '', tone: 'dim' },
  { label: 'A) naive — hold token across the pause', result: '401 token_expired', tone: 'bad' },
  { label: 'B) nominee — refresh at call time', result: '200 / 200 OK', tone: 'ok' },
  { label: 'C) nominee + 8 concurrent calls', result: '1 refresh · 8/8', tone: 'ok' },
  { label: 'D) naive refresh, no single-flight ×8', result: '7/8 invalid_grant', tone: 'bad' },
]

const ease = Easing.bezier(0.16, 1, 0.3, 1)

export const Proof: React.FC = () => {
  const frame = useCurrentFrame()
  const reveal = (start: number) => ({
    opacity: interpolate(frame, [start, start + 16], [0, 1], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
      easing: ease,
    }),
    translateY: interpolate(frame, [start, start + 16], [12, 0], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
      easing: ease,
    }),
  })

  const chipStart = 24 + rows.length * 22 + 14

  return (
    <AbsoluteFill
      style={{
        backgroundColor: c.paper,
        backgroundImage: `radial-gradient(820px 480px at 100% -25%, ${hexA(c.seal, 0.07)}, transparent 70%)`,
        justifyContent: 'center',
        alignItems: 'center',
        fontFamily: mono,
      }}
    >
      {/* heading */}
      <div
        style={{
          width: 1040,
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          marginBottom: 18,
          ...transform(reveal(6)),
        }}
      >
        <Seal size={26} color={c.seal} />
        <span style={{ fontFamily: display, fontWeight: 600, fontSize: 22, color: c.ink }}>
          nominee
        </span>
        <span style={{ fontFamily: mono, fontSize: 16, color: c.muted, marginLeft: 6 }}>
          your agent's OAuth refresh, under rotation + concurrency
        </span>
      </div>

      {/* terminal */}
      <div
        style={{
          width: 1040,
          background: term.bg,
          borderRadius: 16,
          border: `1px solid ${term.line}`,
          boxShadow: '0 30px 80px rgba(11,16,32,0.18)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '16px 22px',
            borderBottom: `1px solid ${term.line}`,
          }}
        >
          <Dot color="#ef6b5e" />
          <Dot color="#f5bd4f" />
          <Dot color="#61c554" />
          <span style={{ color: term.dim, fontSize: 16, marginLeft: 12 }}>
            rotating refresh token · 8 concurrent calls
          </span>
        </div>

        <div style={{ padding: '26px 30px', display: 'flex', flexDirection: 'column', gap: 16 }}>
          {rows.map((r, i) => {
            const { opacity, translateY } = reveal(24 + i * 22)
            const color = r.tone === 'ok' ? GREEN : r.tone === 'bad' ? RED : term.dim
            return (
              <div
                key={r.label}
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  justifyContent: 'space-between',
                  gap: 24,
                  fontSize: 26,
                  opacity,
                  translate: `0px ${translateY}px`,
                }}
              >
                <span style={{ color: r.tone === 'dim' ? term.dim : term.text }}>{r.label}</span>
                {r.result ? (
                  <span style={{ color, fontWeight: 500, whiteSpace: 'nowrap' }}>
                    {r.tone === 'ok' ? '✓ ' : '✗ '}
                    {r.result}
                  </span>
                ) : null}
              </div>
            )
          })}
        </div>
      </div>

      {/* verdict chip */}
      <div
        style={{
          width: 1040,
          marginTop: 22,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          ...transform(reveal(chipStart)),
        }}
      >
        <span
          style={{
            fontFamily: display,
            fontWeight: 600,
            fontSize: 30,
            color: c.ink,
            letterSpacing: '-0.02em',
          }}
        >
          naive <span style={{ color: RED }}>7/8 fail</span> → nominee{' '}
          <span style={{ color: c.ok }}>8/8</span>
          <span style={{ color: c.muted, fontSize: 22, fontFamily: mono, marginLeft: 12 }}>
            same agent code
          </span>
        </span>
        <span style={{ fontFamily: mono, fontSize: 18, color: c.seal }}>nominee.dev</span>
      </div>
    </AbsoluteFill>
  )
}

const Dot: React.FC<{ color: string }> = ({ color }) => (
  <span
    style={{ width: 12, height: 12, borderRadius: 999, background: color, display: 'inline-block' }}
  />
)

function transform(r: { opacity: number; translateY: number }) {
  return { opacity: r.opacity, translate: `0px ${r.translateY}px` }
}
