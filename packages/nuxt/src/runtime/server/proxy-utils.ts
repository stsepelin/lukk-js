import type { H3Event } from 'h3'
import { getRequestHeader } from 'h3'

/**
 * Build an upstream URL contained to `base` — same origin AND under its path
 * prefix. The origin is baked into `prefix`, so a cross-origin or traversal
 * target (including encoded `%2e%2e`, which `new URL` normalizes) fails the one
 * `startsWith` check. `base` is always FIXED server config, never request-derived,
 * so this is the SSRF / open-proxy guard for both proxies.
 */
export function resolveTarget(base: string, subpath: string): string | null {
  try {
    const b = new URL(base)
    const prefix = `${b.origin}${b.pathname.replace(/\/$/, '')}/`
    const target = new URL(`${base.replace(/\/$/, '')}/${subpath.replace(/^\//, '')}`)
    if (!`${target.origin}${target.pathname}/`.startsWith(prefix)) return null
    return target.toString()
  }
  catch {
    return null
  }
}

/**
 * CSRF guard: true when a state-changing (non-GET/HEAD) request carries an
 * `Origin` whose host isn't this app's. The proxies are same-origin by design,
 * so a foreign Origin means a cross-site request riding the session cookie.
 */
export function isForeignOrigin(event: H3Event): boolean {
  if (event.method === 'GET' || event.method === 'HEAD') return false
  const origin = getRequestHeader(event, 'origin')
  if (!origin) return false
  const host = getRequestHeader(event, 'host')
  try {
    return new URL(origin).host !== host
  }
  catch {
    return true
  }
}
