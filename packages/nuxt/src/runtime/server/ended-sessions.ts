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
 * Kept per server process, on `globalThis` — Nitro's handlers and the Nuxt app's server bundle (SSR
 * hydration) each get their OWN copy of this module, and a module-level Map left hydration checking one
 * nothing ever wrote. Behind a load balancer without sticky sessions, or on serverless and edge runtimes,
 * another instance never sees that record: configure `session.sharedStore` (a Nitro storage mount such
 * as Redis) and it is written there too, and read there when the process has no entry.
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
    // Evicting a LIVE entry means the guard has stopped covering that session. Not a memory problem —
    // but a silent loss of protection, so say so once.
    if (expires > now) warnSaturated()
    ended.delete(id)
  }

  ended.delete(key)
  ended.set(key, now + ENDED_SESSION_TTL_MS)
}

export function isSessionEnded(key: string | undefined, now = Date.now()): boolean {
  // Stryker disable next-line ConditionalExpression: equivalent — `markSessionEnded` never stores an empty key, so the lookup below answers false for one anyway. Kept to name the case. This also hides `→ true`, which "remembers an ended session for the TTL, then forgets it" kills.
  if (!key) return false
  const expires = ended.get(key)
  return (expires ?? 0) > now
}

// Flags on `globalThis` too, for the reason the record is: each server bundle has its own module copy,
// and module-level flags reported an outage twice and backed off in one bundle only.
interface RecordFlags { warned: boolean, storeFailureReported: boolean, storeDownUntil: number }
// Stryker disable next-line ObjectLiteral: equivalent — every reader treats a missing flag as false and a missing time as 0.
const flags: RecordFlags = ((globalThis as { __lukkEndedSessionFlags?: RecordFlags }).__lukkEndedSessionFlags ??= { warned: false, storeFailureReported: false, storeDownUntil: 0 })
function warnSaturated(): void {
  if (flags.warned) return
  flags.warned = true
  console.warn(`[lukk-nuxt] More than ${ENDED_SESSION_LIMIT} sessions were replaced or ended within ${ENDED_SESSION_TTL_MS / 60_000} minutes; the oldest are no longer guarded against a late refresh writing them back.`)
}

/** A store every server instance reads and writes — see `session.sharedStore` and the server plugin. */
export interface SharedEndedSessions {
  mark: (key: string, ttlMs: number) => Promise<void>
  has: (key: string) => Promise<boolean>
}

const sharedStore = (): SharedEndedSessions | undefined =>
  (globalThis as { __lukkSharedEndedSessions?: SharedEndedSessions }).__lukkSharedEndedSessions

export function useSharedEndedSessions(store: SharedEndedSessions | undefined): void {
  (globalThis as { __lukkSharedEndedSessions?: SharedEndedSessions }).__lukkSharedEndedSessions = store
}

/** How long a sign-in, logout, refresh or render waits on the shared store before going on without it. */
export const SHARED_STORE_TIMEOUT_MS = 300

/** After a store failure, how long the store is left alone before it is asked again. */
export const SHARED_STORE_BACKOFF_MS = 30_000

/**
 * Record that a session ended — in this process, and in the shared store when one is configured.
 * Awaited before the sign-in or logout's response leaves, so another instance already sees it by the
 * time the browser holds the newer cookie. A store that fails is reported once and the process-local
 * record still stands: that is the guarantee without a shared store, not a failed request.
 *
 * `replaced`: a SIGN-IN ended it, so the browser already holds a newer session's cookie — which a late
 * logout for this one must not clear. A logout's own record doesn't say that, so a logout resent after
 * its first response was lost still clears the dead cookie.
 */
export async function endSession(key: string | undefined, options: { replaced?: boolean } = {}): Promise<void> {
  if (!key) return
  markSessionEnded(key)
  if (options.replaced) markSessionEnded(replacedKey(key))

  await viaStore(async (store) => {
    await store.mark(key, ENDED_SESSION_TTL_MS)
    if (options.replaced) await store.mark(replacedKey(key), ENDED_SESSION_TTL_MS)
  }, undefined)
}

/** Has this session ended — here, or (with a shared store) on any instance? */
export async function sessionEnded(key: string | undefined): Promise<boolean> {
  if (!key) return false
  if (isSessionEnded(key)) return true
  return viaStore(store => store.has(key), false)
}

/** Was it ended by a sign-in that replaced it (rather than by a logout)? */
export async function sessionReplaced(key: string | undefined): Promise<boolean> {
  if (!key) return false
  if (isSessionEnded(replacedKey(key))) return true
  return viaStore(store => store.has(replacedKey(key)), false)
}

const replacedKey = (key: string) => `replaced:${key}`

/**
 * Ask the shared store, bounded. A store that is slow or unreachable must not hold up the requests it
 * protects: a Redis client retrying a dead host took over ten seconds to give up, on every sign-in,
 * logout, refresh — and three times per signed-in page. Past the timeout the answer is the fallback,
 * and the store is left alone for a while before it is asked again.
 */
async function viaStore<T>(operation: (store: SharedEndedSessions) => Promise<T>, fallback: T): Promise<T> {
  const store = sharedStore()
  if (!store || Date.now() < flags.storeDownUntil) return fallback

  return new Promise<T>((resolve) => {
    const fail = (error: unknown) => {
      clearTimeout(timer)
      flags.storeDownUntil = Date.now() + SHARED_STORE_BACKOFF_MS
      reportStoreFailure(error)
      resolve(fallback)
    }
    const timer = setTimeout(() => fail(new Error(`no answer within ${SHARED_STORE_TIMEOUT_MS}ms`)), SHARED_STORE_TIMEOUT_MS)

    Promise.resolve().then(() => operation(store)).then((answer) => {
      clearTimeout(timer)
      // Answered: arm the report again, so a LATER outage is not silent for the life of the process.
      // Only the flag resets, never the backoff — this only runs once the backoff has already elapsed.
      flags.storeFailureReported = false
      resolve(answer)
    }, fail)
  })
}

function reportStoreFailure(error: unknown): void {
  if (flags.storeFailureReported) return
  flags.storeFailureReported = true
  console.error('[lukk-nuxt] session.sharedStore failed or timed out; replaced sessions are only guarded within each server process until it answers again.', error)
}

/** Test seam. */
export function forgetEndedSessions(): void {
  ended.clear()
  flags.warned = false
  flags.storeFailureReported = false
  flags.storeDownUntil = 0
}

/** Test seam: how many entries are held — pruning is only observable through this. */
export function endedSessionCount(): number {
  return ended.size
}
