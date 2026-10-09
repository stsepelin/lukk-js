import type { H3Event } from 'h3'
import { sealSession, setResponseHeader, useSession } from 'h3'
import { useRuntimeConfig } from '#imports'
import { sessionCookieName } from '../shared'
import { accessExpired } from './access-token'
import { visitorIp } from './proxy-utils'
import { sessionEnded, sessionKey, withholdSessionCookie } from './ended-sessions'
import { logoutNoted } from './logout-note'
import { revokeDroppedSession } from './revoke-dropped'
import { readSealedSessionWithId, sessionCookie, sessionSeal } from './sealed-session'
import { warnIfSessionTooLarge } from './session-size'
import { currentPair, refreshOnce, type TokenSession } from './refresh'

interface LukkServerConfig {
  sessionPassword?: string
  cookieSecure?: boolean
  cookieNamespace?: string
  clientIpHeader?: string
  baseURL?: string
  sessionMaxAge?: number
}

/**
 * Resolve a still-valid lukk access token for BFF SSR hydration — refreshing and
 * RE-SEALING the session in place when the access token has aged out but the refresh
 * token is still good, so an authenticated FULL page load never flashes /login.
 *
 * Distinct from `getLukkAccessToken` (read-only — never mints/slides the cookie, safe in a
 * streamed-proxy context): this one deliberately rotates + reseals. The catastrophic failure to
 * avoid is rotating the SAME refresh token twice in one render (the second use is a replay →
 * lukk reuse detection → whole-family revoke). The in-process request-cookie mirror is what
 * prevents that:
 *  - it rotates ONCE via `refreshOnce`, then writes the fresh seal onto BOTH the page RESPONSE
 *    (h3's `update` → Set-Cookie, so the browser receives the rotated cookie — never stranded
 *    server-side) AND the in-process REQUEST cookie. So the same render's `fetchUser` (which
 *    streams through the app-API proxy, forwarding the request cookie) unseals the ALREADY-rotated
 *    session, sees a non-expired access token, and injects it — instead of unsealing the stale
 *    cookie and rotating the just-consumed refresh token a second time. Note the SEQUENTIAL order
 *    matters: `refreshOnce`'s single-flight entry is already cleared (once the refresh settles) by the time
 *    `fetchUser` runs, so the single-flight does NOT backstop this — the mirror alone does. The
 *    single-flight only collapses genuinely CONCURRENT refreshes of one session (e.g. sibling
 *    component fetches) into one `/refresh`.
 *
 * Opens the read-write session ONLY to rotate — a valid or anonymous session never mints a
 * cookie (the read-only unseal + early returns gate that). Returns null for an anonymous,
 * unrefreshable, or failed/revoked refresh; the caller then defers to the client-side restore.
 */
export async function resolveHydrationAccess(event: H3Event): Promise<string | null> {
  const { sessionPassword, cookieSecure, cookieNamespace, clientIpHeader, baseURL, sessionMaxAge } = (useRuntimeConfig(event).lukk ?? {}) as LukkServerConfig
  const secure = cookieSecure !== false
  const name = sessionCookieName(secure, cookieNamespace)

  // A truthy access proves `sessionPassword` was present: readSealed only returns data when it
  // unseals, and returns {} without a password — so the rotate path can assert `sessionPassword!`
  // rather than re-check an always-false branch.
  const read = await readSealedSessionWithId(event, sessionPassword, name)
  const sealed = read.data
  const access = sealed.access
  if (!access) return null

  // Any request carrying a real session is per-user, whether or not this render ends up hydrating it:
  // components that fetch during SSR without gating on `ready` still render that account's data (the
  // app-API proxy serves a still-valid token), and a shared cache must not store the page.
  setResponseHeader(event, 'cache-control', 'no-store')

  // A logout the browser noted before this request: rendered signed out, even if lukk couldn't be told yet
  // (see `finish-logout`).
  if (logoutNoted(event, secure, cookieNamespace)) return null

  // A session a sign-in replaced or a logout ended is not rendered as signed in, even with a token still
  // valid: the tab would show that account while every call it makes acts as the newer session. The
  // client restores with the cookie the browser now holds. A seal from before `sid` existed is keyed by
  // h3's id, which the read-only unseal also returns.
  const key = sessionKey(read)
  if (await sessionEnded(key)) return null
  if (!accessExpired(access)) {
    remember(event, key, name)
    return access
  }
  if (!sealed.refresh || !baseURL) return null

  try {
    // A valid seal restores its id, so opening the read-write session here mints no cookie.
    const session = await useSession<TokenSession>(event, {
      password: sessionPassword!,
      name,
      cookie: sessionCookie(secure, sessionMaxAge),
      // h3 otherwise accepts a sealed session from the `x-<name>-session` REQUEST HEADER in
      // preference to the cookie — an auth channel outside `__Host-`, Secure, HttpOnly and
      // SameSite=Strict. Nothing here reads it, but leaving a door open on a session primitive
      // isn't worth the two words it costs to close.
      sessionHeader: false,
      // Every seal written to the browser gets a lifetime (see `sessionSeal`). Not the in-process mirror
      // below: that one never leaves this request.
      seal: sessionSeal(sessionMaxAge),
    })
    // A session a sign-in replaced or a logout ended while this render was out is not re-sealed — that
    // would put it back in the browser. The client decides instead.
    if (await sessionEnded(sessionKey(session))) return null
    const { pair } = await refreshOnce(session, baseURL, visitorIp(event, clientIpHeader))
    // Stryker disable next-line OptionalChaining: equivalent — a null pair makes `.access` throw into the catch below, which returns null too.
    if (!pair?.access) return null
    if (await sessionEnded(sessionKey(session))) {
      revokeDroppedSession(event, pair, baseURL, visitorIp(event, clientIpHeader))
      return null
    }

    await session.update(pair)
    warnIfSessionTooLarge(session) // parity with bff.ts — the SSR reseal can cross the budget first
    // The render takes a while, and the cookie only goes out with the page — see `withholdIfReplaced`.
    // `sealedPair` follows each re-seal: the check can run twice (app:error, then app:rendered), and the
    // second compares — and revokes — what the first sealed.
    let sealedPair = pair
    remember(event, sessionKey(session), name, () => revokeDroppedSession(event, sealedPair, baseURL, visitorIp(event, clientIpHeader)), async () => {
      const newest = currentPair(sessionKey(session), sealedPair)
      // Moved past it, and the links that led on have expired: not this cookie at all.
      if (!newest) return withholdSessionCookie(event.node.res, name)
      if (newest === sealedPair) return
      await session.update(newest)
      sealedPair = newest
    })
    const fresh = await sealSession(event, { password: sessionPassword!, name })
    replaceRequestCookie(event, name, fresh)
    return pair.access
  }
  catch {
    // A throw in a plugin's setup breaks the SSR render — swallow and defer to the client restore.
    return null
  }
}

/**
 * Called once the page has rendered, before its response is sent: if a sign-in or logout ended the
 * session this render re-sealed, withhold that cookie so it cannot land over the newer one. The page
 * itself was still rendered for the old session — a tab that loaded during a sign-in shows the
 * account it loaded with until it reloads — but the browser keeps the newer session.
 */
export async function withholdIfReplaced(event: H3Event): Promise<void> {
  const hydrated = hydratedSession(event)
  if (!hydrated) return
  if (!(await sessionEnded(hydrated.key))) return resealNewest(event, hydrated)
  dropEnded(event, hydrated)
}

/** The session this render re-sealed ended: revoke what it sealed, once, and withhold its cookie. */
function dropEnded(event: H3Event, hydrated: HydratedSession): void {
  // The tokens this render re-sealed are being dropped: revoke them, once — this runs both right after
  // the user load and again from the render hooks.
  if (hydrated.revoke) {
    hydrated.revoke()
    hydrated.revoke = undefined
  }

  // Too late once the headers are out — a streamed render (Nuxt's `ssrStreaming`) calls the render
  // hooks after the response has started, and touching a sent header throws. The plugin's own check
  // right after the user load covers that case while the headers are still open.
  if (event.node.res.headersSent) return
  try { withholdSessionCookie(event.node.res, hydrated.name) }
  catch { /* the response started meanwhile; nothing left to withhold */ }
}

/** Did a sign-in or logout end the session this render hydrated, while it was rendering? */
export function hydratedSessionEnded(event: H3Event): Promise<boolean> {
  return sessionEnded(hydratedSession(event)?.key)
}

/**
 * Not replaced: but if this render re-sealed the session, the session may have rotated that pair since (a
 * restore in another tab), and the page's cookie would land over the newer one with a token already spent.
 * Re-sealed with the newest the journal knows, while the headers are still open.
 */
async function resealNewest(event: H3Event, hydrated: HydratedSession): Promise<void> {
  if (!hydrated.reseal || event.node.res.headersSent) return
  try {
    await hydrated.reseal()
    // Sealing takes a moment, after the last check: a logout or sign-in landing during it must not have the
    // ended session's cookie leave with the page.
    if (await sessionEnded(hydrated.key)) dropEnded(event, hydrated)
  }
  catch { /* the response started meanwhile; it keeps the seal it had */ }
}

/**
 * `revoke` only when this render re-sealed the session: those rotated tokens are the ones to end. `reseal`
 * likewise: re-seal with the newest pair, should the session have rotated the one sealed here.
 */
interface HydratedSession { key?: string, name: string, revoke?: () => void, reseal?: () => Promise<void> }

function remember(event: H3Event, key: string | undefined, name: string, revoke?: () => void, reseal?: () => Promise<void>): void {
  (event.context as { lukkHydrated?: HydratedSession }).lukkHydrated = { key, name, revoke, reseal }
}

function hydratedSession(event: H3Event): HydratedSession | undefined {
  return (event.context as { lukkHydrated?: HydratedSession }).lukkHydrated
}

/** Swap our session cookie in the in-process request header for the freshly-rotated seal. */
function replaceRequestCookie(event: H3Event, name: string, sealed: string): void {
  const header = event.node.req.headers.cookie
  const others = header
    ? header.split(';').map((c: string) => c.trim()).filter((c: string) => c && !c.startsWith(`${name}=`))
    : []
  others.push(`${name}=${sealed}`)
  event.node.req.headers.cookie = others.join('; ')
}
