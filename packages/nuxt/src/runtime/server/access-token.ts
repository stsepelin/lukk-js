/**
 * Whether a lukk access JWT is at/near expiry (10s skew) — **decoded, not verified**
 * (the seal already authenticated it server-side). Shared by the app-API proxy's
 * proactive refresh and the SSR hydration plugin's "don't rotate mid-render" gate, so
 * the two never drift on what counts as expired.
 */
export function accessExpired(jwt: string): boolean {
  const parts = jwt.split('.')
  if (parts.length !== 3) return true // malformed → refresh
  try {
    // Decode base64url via `base64` (universally-typed `BufferEncoding`; this file is pulled
    // into the app/plugin compile context where `base64url` isn't in the encoding union).
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const payload = JSON.parse(Buffer.from(b64, 'base64').toString()) as { exp?: number }
    return typeof payload.exp !== 'number' || payload.exp * 1000 <= Date.now() + 10_000
  }
  catch {
    return true
  }
}
