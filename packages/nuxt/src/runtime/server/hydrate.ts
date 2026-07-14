import type { H3Event } from 'h3'
import { getCookie, sealSession, unsealSession, useSession } from 'h3'
import { useRuntimeConfig } from '#imports'
import { sessionCookieName } from '../shared'
import { accessExpired } from './access-token'
import { warnIfSessionTooLarge } from './session-size'
import { refreshOnce, type TokenSession } from './utils/refresh'

interface LukkServerConfig {
  sessionPassword?: string
  cookieSecure?: boolean
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
  const { sessionPassword, cookieSecure, baseURL } = (useRuntimeConfig(event).lukk ?? {}) as LukkServerConfig
  const secure = cookieSecure !== false
  const name = sessionCookieName(secure)

  // A truthy access proves `sessionPassword` was present: readSealed only returns data when it
  // unseals, and returns {} without a password — so the rotate path can assert `sessionPassword!`
  // rather than re-check an always-false branch.
  const sealed = await readSealed(event, sessionPassword, name)
  const access = sealed.access
  if (!access) return null
  if (!accessExpired(access)) return access
  if (!sealed.refresh || !baseURL) return null

  try {
    // A valid seal restores its id, so opening the read-write session here mints no cookie.
    const session = await useSession<TokenSession>(event, {
      password: sessionPassword!,
      name,
      cookie: { sameSite: 'strict', secure, httpOnly: true, path: '/' },
    })
    const pair = await refreshOnce(session, baseURL)
    if (!pair?.access) return null

    await session.update(pair)
    warnIfSessionTooLarge(session) // parity with bff.ts — the SSR reseal can cross the budget first
    const fresh = await sealSession(event, { password: sessionPassword!, name })
    replaceRequestCookie(event, name, fresh)
    return pair.access
  }
  catch {
    // A throw in a plugin's setup breaks the SSR render — swallow and defer to the client restore.
    return null
  }
}

/** Read-only unseal of the sealed session — never mints or slides the cookie. */
async function readSealed(event: H3Event, password: string | undefined, name: string): Promise<TokenSession> {
  const sealed = getCookie(event, name)
  if (!sealed || !password) return {}
  try {
    const unsealed = await unsealSession(event, { password, name }, sealed)
    return (unsealed as { data?: TokenSession }).data ?? {}
  }
  catch {
    // Tampered, expired, or wrong-secret seal → treat as no session.
    return {}
  }
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
