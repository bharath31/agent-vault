/**
 * The anti-pattern. A hand-rolled agent grabs a token and holds onto it. There
 * is no refresh, no call-time re-resolution — exactly what nominee removes.
 */
export function captureToken(token: string): { token: string; capturedAtMs: number } {
  return { token, capturedAtMs: Date.now() }
}
