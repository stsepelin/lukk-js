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
export function revokeDroppedSession(event: H3Event, tokens: { access?: string, refresh?: string }, baseURL: string, clientIp = ''): void {
  const target = tokens.access || tokens.refresh ? resolveTarget(baseURL, '/logout') : null
  if (!target) return

  // Both credentials: the access token for any lukk release, the refresh token for those that accept
  // it — which still ends the session when the access token has already expired.
  const headers: Record<string, string> = { 'Accept': 'application/json', 'Content-Type': 'application/json' }
  if (tokens.access) headers.Authorization = `Bearer ${tokens.access}`
  if (clientIp) headers['X-Forwarded-For'] = clientIp
  const body = JSON.stringify(tokens.refresh ? { refresh_token: tokens.refresh } : {})

  const revocation = fetch(target, { method: 'POST', headers, body, redirect: 'manual' }).then(() => {}, () => {})
  ;(event as { waitUntil?: (promise: Promise<unknown>) => void }).waitUntil?.(revocation)
}
