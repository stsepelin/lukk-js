import type { H3Event } from 'h3'
import { appendResponseHeader, defineEventHandler, deleteCookie, getCookie, getRequestHeader, setCookie, setResponseHeader } from 'h3'
import { useRuntimeConfig } from '#imports'
import { LUKK_BFF_PREFIX, logoutCookieName, sessionCookieName, signedOutCookieName } from '../shared'
import { sessionKey, sessionReplaced } from './ended-sessions'
import type { EndedHere } from './logout-note'
import { readSealedSessionWithId } from './sealed-session'

/**
 * Finish a logout the browser noted before this request — see `logoutCookieName`.
 *
 * A page that navigates away right after `logout()` sends its request on `pagehide`, which a browser
 * fires only once the NEXT page's response is in: that page's request still carried the session, and
 * the page rendered signed in. The note rides that request, so the session is ended here, before
 * anything renders — through the proxy's own `/logout`, with everything it does (the refresh token, a
 * renewal on an older lukk, the ended-session record, clearing the cookie).
 *
 * The note says nothing about WHICH session: it doesn't need to. Every response that seals a new session
 * clears it, so a note that is still here was written after the session this request carries.
 *
 * Whatever happens here, a request carrying the note is served signed out (see `logout-note`). If lukk
 * can't be reached, the note stays and the browser finishes the logout itself, as it would without this.
 *
 * Deliberately NOT under `server/utils`, so it is not auto-imported into the app.
 */

/** How long a page load waits on lukk before rendering signed out and leaving the logout to the browser. */
export const FINISH_LOGOUT_TIMEOUT_MS = 5_000

/** After a logout that didn't go through, how long requests carrying the same session leave lukk alone. */
export const RETRY_AFTER_FAILURE_MS = 10_000

// One logout per session at a time: every request a page makes before its response lands carries the note.
const inFlight = new Map<string, Promise<Response | undefined>>()
// And not one per request while it keeps failing: a page load is many requests, and each waited the timeout.
const failedUntil = new Map<string, number>()

export default defineEventHandler(async (event) => {
  const { cookieSecure, cookieNamespace, sessionPassword } = useRuntimeConfig(event).lukk as { cookieSecure?: boolean, cookieNamespace?: string, sessionPassword?: string }
  const secure = cookieSecure !== false
  const note = logoutCookieName(secure, cookieNamespace)
  if (!getCookie(event, note)) return
  // The proxy's own calls: the browser finishing the logout, or signing in — which replaces the session
  // and clears the note itself.
  if (event.path === LUKK_BFF_PREFIX || event.path.startsWith(`${LUKK_BFF_PREFIX}/`)) return

  // Per-user whatever the outcome: it clears this visitor's cookies, or renders them signed out. Before the
  // early returns below, which also answer with a `Set-Cookie` a shared cache must not store.
  setResponseHeader(event, 'cache-control', 'no-store')
  setResponseHeader(event, 'vary', 'cookie')

  const session = sessionCookieName(secure, cookieNamespace)
  const sealed = getCookie(event, session)
  // A cookie that does not UNSEAL is not a session: an unauthenticated caller could otherwise hand us any
  // string and buy a page load held for the timeout plus an upstream request, once per value they invent.
  // Its `sid` also keys the work below, so a browser cannot spend another's back-off entry.
  const { id, data } = sealed ? await readSealedSessionWithId(event, sessionPassword, session) : { id: undefined, data: {} }
  const key = sessionKey({ id, data })
  if (!key || !(data.access ?? data.refresh)) {
    deleteCookie(event, note, { path: '/', secure, sameSite: 'strict' })
    return
  }

  if ((failedUntil.get(key) ?? 0) > Date.now()) return

  const res = await finishOnce(event, key)
  // `?.()` as well: a runtime whose `Headers` predates `getSetCookie` would throw here, in middleware,
  // and 500 every page load rather than degrade to the browser finishing its own logout.
  const forwarded = res?.headers.getSetCookie?.() ?? []
  // The proxy clears the note exactly when the session is over — not for a 401 it could still renew past,
  // nor when a renewal re-sealed it and the logout then failed.
  const ended = forwarded.some(cookie => nameOf(cookie) === note)
  if (!ended) noteFailure(key)

  // A session RE-SEALED here (a renewal before a logout that then failed) must reach the browser: it holds a
  // refresh token this server has already spent. Never the CLEARED cookie, though — this response is
  // finalised long before it lands, and a sign-in in another tab meanwhile would have its newer cookie wiped
  // by it. The browser's own logout request clears that cookie when its response lands; until then every
  // path here treats the session as ended (the record) and the visitor as signed out (the note).
  // …and not onto a response a sign-in has replaced meanwhile: it would land after the newer cookie and
  // strand the session the visitor just signed into.
  const keepCookies = !(await sessionReplaced(key))
  for (const cookie of forwarded) {
    if (keepCookies && nameOf(cookie) === session && !cookie.startsWith(`${session}=;`) && cookie !== `${session}=`) {
      appendResponseHeader(event, 'set-cookie', cookie)
    }
  }
  // Checked again before the headers go out, whatever happened here: a sign-in elsewhere meanwhile must not
  // have its new cookie replaced by anything this response carries (see `withholdSignedOutCookie`).
  const marker = signedOutCookieName(secure, cookieNamespace)
  ;(event.context as { lukkEndedSession?: EndedHere }).lukkEndedSession = { key, marker, session }

  if (!ended || !keepCookies) return

  // Done: the note goes, and a short-lived cookie says so, which the page's restore reads — it then knows it
  // is signed out without asking, and tells the visitor's other tabs.
  deleteCookie(event, note, { path: '/', secure, sameSite: 'strict' })
  setCookie(event, marker, '1', { path: '/', secure, sameSite: 'strict', maxAge: 10 })
})

const nameOf = (cookie: string) => cookie.slice(0, cookie.indexOf('='))

/** At most this many sessions remembered as failing; the oldest go first. */
export const FAILURE_LIMIT = 1_000

function noteFailure(key: string, now = Date.now()): void {
  failedUntil.delete(key)
  // Bounded whatever the request rate: expired entries go first, then the oldest.
  if (failedUntil.size >= FAILURE_LIMIT) {
    for (const [held, until] of failedUntil) if (until <= now) failedUntil.delete(held)
    for (const held of failedUntil.keys()) {
      if (failedUntil.size < FAILURE_LIMIT) break
      failedUntil.delete(held)
    }
  }
  failedUntil.set(key, now + RETRY_AFTER_FAILURE_MS)
}

/** Test seam. */
export function forgetLogoutFailures(): void {
  failedUntil.clear()
}

/** Test seam: how many failures are held — pruning is only observable through this. */
export function logoutFailureCount(): number {
  return failedUntil.size
}

function finishOnce(event: H3Event, sealed: string): Promise<Response | undefined> {
  let pending = inFlight.get(sealed)
  if (!pending) {
    pending = send(event).finally(() => inFlight.delete(sealed))
    inFlight.set(sealed, pending)
  }
  return pending
}

/**
 * POST the proxy's `/logout` in-process. `event.fetch` copies the page request's headers (and keeps the
 * runtime's context, which the proxy's config may need); the ones that describe how the PAGE was
 * requested are blanked — a navigation from a sibling subdomain says `sec-fetch-site: same-site`, which
 * the proxy's CSRF check rightly refuses for a POST.
 */
async function send(event: H3Event): Promise<Response | undefined> {
  const local = (event as { fetch?: (input: string, init: RequestInit) => Promise<Response> }).fetch
  if (!local) return undefined

  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<undefined>((resolve) => { timer = setTimeout(resolve, FINISH_LOGOUT_TIMEOUT_MS) })
  const request = local(`${LUKK_BFF_PREFIX}/logout`, {
    method: 'POST',
    headers: {
      'accept': 'application/json',
      'content-type': 'application/json',
      'content-length': '2',
      'cookie': getRequestHeader(event, 'cookie')!,
      'origin': '',
      'referer': '',
      'sec-fetch-site': '',
      'sec-fetch-mode': '',
      'sec-fetch-dest': '',
    },
    body: '{}',
  }).catch(() => undefined)
  // Past the timeout the page renders without it; the logout still completes where the runtime allows.
  ;(event as { waitUntil?: (promise: Promise<unknown>) => void }).waitUntil?.(request)

  try { return await Promise.race([request, timeout]) }
  finally { clearTimeout(timer) }
}
