import type { H3Event } from 'h3'
import { resolveTarget } from './proxy-utils'

/**
 * End a session whose rotated tokens this server is about to throw away.
 *
 * A refresh that answers for a session a sign-in replaced (or a logout ended) is never written back —
 * but lukk has already rotated it: the refresh token the browser may still hold is consumed, and its
 * replacement exists only here. If that browser keeps the old cookie (the sign-in's response was lost),
 * its next refresh arrives after the grace window with a consumed token, and lukk's reuse detection
 * revokes the family and reports a THEFT that never happened. Revoking it now, with the access token it
 * just issued, turns that into an ordinary "revoked".
 *
 * Best effort and in the background: the request this runs for must not wait on it, and a failure
 * leaves things no worse than before. `waitUntil` keeps it alive on runtimes that end the invocation
 * with the response.
 *
 * Deliberately NOT under `server/utils`, so it is not auto-imported into the app.
 */
export function revokeDroppedSession(event: H3Event, access: string | undefined, baseURL: string, clientIp = ''): void {
  const target = access ? resolveTarget(baseURL, '/logout') : null
  if (!target) return

  const headers: Record<string, string> = { Accept: 'application/json', Authorization: `Bearer ${access}` }
  if (clientIp) headers['X-Forwarded-For'] = clientIp

  const revocation = fetch(target, { method: 'POST', headers, redirect: 'manual' }).then(() => {}, () => {})
  ;(event as { waitUntil?: (promise: Promise<unknown>) => void }).waitUntil?.(revocation)
}
