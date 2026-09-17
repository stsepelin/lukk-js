import type { H3Event } from 'h3'
import { sealSession, setResponseHeader, useSession } from 'h3'
import { useRuntimeConfig } from '#imports'
import { sessionCookieName } from '../shared'
import { accessExpired } from './access-token'
import { visitorIp } from './proxy-utils'
import { isSessionEnded, sessionKey, withholdSessionCookie } from './ended-sessions'
import { revokeDroppedSession } from './revoke-dropped'
import { readSealedSession } from './sealed-session'
import { warnIfSessionTooLarge } from './session-size'
import { refreshOnce, type TokenSession } from './utils/refresh'

interface LukkServerConfig {
  sessionPassword?: string
  cookieSecure?: boolean
  cookieNamespace?: string
  clientIpHeader?: string
  baseURL?: string
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
 *    matters: `refreshOnce`'s single-flight entry is already cleared (its `.finally`) by the time
 *    `fetchUser` runs, so the single-flight does NOT backstop this — the mirror alone does. The
 *    single-flight only collapses genuinely CONCURRENT refreshes of one session (e.g. sibling
 *    component fetches) into one `/refresh`.
 *
 * Opens the read-write session ONLY to rotate — a valid or anonymous session never mints a
 * cookie (the read-only unseal + early returns gate that). Returns null for an anonymous,
 * unrefreshable, or failed/revoked refresh; the caller then defers to the client-side restore.
 */
export async function resolveHydrationAccess(event: H3Event): Promise<string | null> {
  const { sessionPassword, cookieSecure, cookieNamespace, clientIpHeader, baseURL } = (useRuntimeConfig(event).lukk ?? {}) as LukkServerConfig
  const secure = cookieSecure !== false
  const name = sessionCookieName(secure, cookieNamespace)

  // A truthy access proves `sessionPassword` was present: readSealed only returns data when it
  // unseals, and returns {} without a password — so the rotate path can assert `sessionPassword!`
  // rather than re-check an always-false branch.
  const sealed = await readSealedSession(event, sessionPassword, name)
  const access = sealed.access
  if (!access) return null

  // Any request carrying a real session is per-user, whether or not this render ends up hydrating it:
  // components that fetch during SSR without gating on `ready` still render that account's data (the
  // app-API proxy serves a still-valid token), and a shared cache must not store the page.
  setResponseHeader(event, 'cache-control', 'no-store')

  // A session a sign-in replaced or a logout ended is not rendered as signed in, even with a token still
  // valid: the tab would show that account while every call it makes acts as the newer session. The
  // client restores with the cookie the browser now holds. (A seal from before `sid` existed can only
  // be checked on the refresh path, which opens the session and so knows h3's id.)
  if (isSessionEnded(sealed.sid)) return null
  if (!accessExpired(access)) {
    remember(event, sealed.sid, name)
    return access
  }
  if (!sealed.refresh || !baseURL) return null

  try {
    // A valid seal restores its id, so opening the read-write session here mints no cookie.
    const session = await useSession<TokenSession>(event, {
      password: sessionPassword!,
      name,
      cookie: { sameSite: 'strict', secure, httpOnly: true, path: '/' },
      // h3 otherwise accepts a sealed session from the `x-<name>-session` REQUEST HEADER in
      // preference to the cookie — an auth channel outside `__Host-`, Secure, HttpOnly and
      // SameSite=Strict. Nothing here reads it, but leaving a door open on a session primitive
      // isn't worth the two words it costs to close.
      sessionHeader: false,
    })
    // A session a sign-in replaced or a logout ended while this render was out is not re-sealed — that
    // would put it back in the browser. The client decides instead.
    if (isSessionEnded(sessionKey(session))) return null
    const { pair } = await refreshOnce(session, baseURL, visitorIp(event, clientIpHeader))
    if (!pair?.access) return null
    if (isSessionEnded(sessionKey(session))) {
      revokeDroppedSession(event, pair.access, baseURL, visitorIp(event, clientIpHeader))
      return null
    }

    await session.update(pair)
    warnIfSessionTooLarge(session) // parity with bff.ts — the SSR reseal can cross the budget first
    // The render takes a while, and the cookie only goes out with the page — see `withholdIfReplaced`.
    remember(event, sessionKey(session), name, () => revokeDroppedSession(event, pair.access, baseURL, visitorIp(event, clientIpHeader)))
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
export function withholdIfReplaced(event: H3Event): void {
  const hydrated = hydratedSession(event)
  if (!hydrated || !isSessionEnded(hydrated.key)) return

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
export function hydratedSessionEnded(event: H3Event): boolean {
  return isSessionEnded(hydratedSession(event)?.key)
}

/** `revoke` only when this render re-sealed the session: those rotated tokens are the ones to end. */
interface HydratedSession { key?: string, name: string, revoke?: () => void }

function remember(event: H3Event, key: string | undefined, name: string, revoke?: () => void): void {
  (event.context as { lukkHydrated?: HydratedSession }).lukkHydrated = { key, name, revoke }
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
