import type React from 'react'

export const Seal: React.FC<{ size?: number; color: string }> = ({ size = 40, color }) => (
  <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden>
    <g fill="none" stroke={color} strokeOpacity={0.9} strokeWidth={1}>
      <circle cx="20" cy="20" r="15" />
      <circle cx="20" cy="20" r="11" strokeOpacity={0.5} />
      <ellipse cx="20" cy="20" rx="15" ry="5" strokeOpacity={0.5} />
      <ellipse cx="20" cy="20" rx="15" ry="5" strokeOpacity={0.5} transform="rotate(60 20 20)" />
      <ellipse cx="20" cy="20" rx="15" ry="5" strokeOpacity={0.5} transform="rotate(120 20 20)" />
    </g>
  </svg>
)
