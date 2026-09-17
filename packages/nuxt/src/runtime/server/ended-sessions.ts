/**
 * Sealed sessions that a sign-in replaced or a logout ended, remembered briefly so a response still
 * in flight for one cannot write it back.
 *
 * The browser keeps whichever `Set-Cookie` arrives LAST. A request that was already out when the
 * session changed — an app-API call renewing an expired token, an SSR render, another tab's restore —
 * carries the old cookie, refreshes it server-side, and answers with that session re-sealed. Landing
 * after a login it put the previous account back under the new one; after a logout it re-created the
 * cookie logout had just cleared. The browser tab can hold back its own refreshes, but not these.
 *
 * Every write path that follows a refresh checks here before rotating, and again as late as it can:
 * right before the response headers go out, withholding the session cookie if the session ended
 * meanwhile. What remains is the time between those headers and the browser storing them.
 *
 * Per server process, like the refresh single-flight in `utils/refresh.ts`: behind a load balancer
 * without sticky sessions, a request served by another instance is not covered. Within the process it
 * lives on `globalThis`: Nitro's handlers and the Nuxt app's server bundle (SSR hydration) each get
 * their OWN copy of this module, and a module-level Map left hydration checking one nothing ever wrote.
 *
 * Deliberately NOT under `server/utils`, so it is not auto-imported into the app.
 */

/** Longer than any request that could still be carrying a replaced session. */
export const ENDED_SESSION_TTL_MS = 10 * 60_000

/** A bound on memory, whatever the sign-in rate. The oldest entries go first. */
export const ENDED_SESSION_LIMIT = 50_000

// Insertion order is expiry order (every entry gets the same TTL, and a re-mark moves to the end).
const ended: Map<string, number> = ((globalThis as { __lukkEndedSessions?: Map<string, number> }).__lukkEndedSessions ??= new Map())

/** The identity a session is remembered by: its own `sid`, or h3's id for one sealed before `sid` existed. */
export function sessionKey(session: { id?: string, data: { sid?: string } }): string | undefined {
  return session.data.sid ?? session.id
}

/**
 * Remove this app's session cookie from the response's queued `Set-Cookie`, leaving any other cookie.
 * For a session that ended after it was re-sealed: the write already happened on the response object,
 * but nothing has been sent yet.
 */
export function withholdSessionCookie(res: { getHeader: (name: string) => unknown, setHeader: (name: string, value: string[]) => unknown, removeHeader: (name: string) => unknown }, name: string): void {
  const queued = res.getHeader('set-cookie')
  if (queued === undefined) return

  const kept = (Array.isArray(queued) ? queued : [String(queued)])
    .filter(cookie => String(cookie).slice(0, String(cookie).indexOf('=')) !== name)

  if (kept.length) res.setHeader('set-cookie', kept)
  else res.removeHeader('set-cookie')
}

/** A fresh id for a session that a sign-in is about to seal. */
export function newSessionId(): string {
  return globalThis.crypto.randomUUID()
}

export function markSessionEnded(key: string | undefined, now = Date.now()): void {
  if (!key) return

  for (const [id, expires] of ended) {
    if (expires > now && ended.size < ENDED_SESSION_LIMIT) break
    ended.delete(id)
  }

  ended.delete(key)
  ended.set(key, now + ENDED_SESSION_TTL_MS)
}

export function isSessionEnded(key: string | undefined, now = Date.now()): boolean {
  if (!key) return false
  const expires = ended.get(key)
  return expires !== undefined && expires > now
}

/** Test seam. */
export function forgetEndedSessions(): void {
  ended.clear()
}

/** Test seam: how many entries are held — pruning is only observable through this. */
export function endedSessionCount(): number {
  return ended.size
}
