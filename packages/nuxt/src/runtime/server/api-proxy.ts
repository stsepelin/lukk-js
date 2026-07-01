import type { H3Event } from 'h3'
import { defineEventHandler, getCookie, getRequestHeader, getRequestIP, proxyRequest, setResponseStatus, unsealSession, useSession } from 'h3'
import { useRuntimeConfig } from '#imports'
import { LUKK_BFF_PREFIX, LUKK_SESSION_COOKIE } from '../shared'
import { accessExpired } from './access-token'
import { isForeignOrigin, resolveTarget } from './proxy-utils'
import { refreshOnce, type TokenSession } from './utils/refresh'

// Browser-settable forwarding / client-IP headers, neutralised so a script can't
// spoof `$request->ip()` upstream. See docs/transport-modes.md.
const SPOOFABLE_FORWARDING = {
  'x-forwarded-host': '',
  'x-forwarded-proto': '',
  'x-forwarded-port': '',
  'forwarded': '',
  'x-real-ip': '',
  'x-client-ip': '',
  'true-client-ip': '',
  'cf-connecting-ip': '',
  'fastly-client-ip': '',
  'x-cluster-client-ip': '',
} as const

/**
 * Optional BFF app-API proxy. Forwards same-origin `${apiPath}/**` to the fixed
 * `apiTarget` (your Laravel API), injecting the lukk access token from the sealed
 * session server-side — so the browser authenticates without ever holding a token.
 *
 * Security (SSRF/CSRF containment, header stripping) is documented in
 * docs/transport-modes.md.
 */
export default defineEventHandler(async (event) => {
  const { apiPath, apiTarget, apiForceJson, baseURL, sessionPassword, apiForwardSetCookie } = useRuntimeConfig(event).lukk as {
    apiPath: string
    apiTarget: string
    apiForceJson: boolean
    baseURL: string
    sessionPassword: string
    apiForwardSetCookie?: string[]
  }
  const forwardSetCookie = apiForwardSetCookie ?? []

  if (isForeignOrigin(event)) {
    setResponseStatus(event, 403)
    return { message: 'Cross-origin request rejected.' }
  }

  const queryAt = event.path.indexOf('?')
  const path = queryAt === -1 ? event.path : event.path.slice(0, queryAt)
  const query = queryAt === -1 ? '' : event.path.slice(queryAt)

  // The lukk BFF routes belong to the other proxy.
  if (path === LUKK_BFF_PREFIX || path.startsWith(`${LUKK_BFF_PREFIX}/`)) {
    setResponseStatus(event, 404)
    return { message: 'Not found.' }
  }

  // Only proxy paths under the mount.
  if (path !== apiPath && !path.startsWith(`${apiPath}/`)) {
    setResponseStatus(event, 404)
    return { message: 'Not found.' }
  }

  // Subpath after the mount, contained to the fixed target by `resolveTarget`.
  const base = resolveTarget(apiTarget, path.slice(apiPath.length) || '/')
  if (!base) {
    setResponseStatus(event, 400)
    return { message: 'Invalid path.' }
  }

  // Read the sealed session READ-ONLY first (never minting or sliding a cookie — h3's
  // useSession would re-seal a fresh *empty* session for an expired/tampered seal,
  // which then collides with the streamed response). Only when the injected access
  // token has actually lapsed do we open the read-write session to rotate — and there
  // the seal is valid, so its id is restored (no re-mint).
  const sealed = await readSession(event, sessionPassword)
  let access = sealed.access
  if (access && sealed.refresh && accessExpired(access)) {
    const session = await useSession<TokenSession>(event, {
      password: sessionPassword,
      name: LUKK_SESSION_COOKIE,
      cookie: { sameSite: 'strict', secure: true, httpOnly: true, path: '/' },
    })
    // Proactive refresh: rotate ONCE (shared single-flight with the BFF proxy) so a
    // streamed request isn't spent on a guaranteed 401. A revoked session still
    // surfaces naturally: the refresh fails → null → the stale bearer → upstream 401.
    const pair = await refreshOnce(session, baseURL)
    if (pair) {
      await session.update(pair)
      access = pair.access
    }
  }
  // Carry any Set-Cookie h3 queued (the rotated session, on a refresh) through the
  // proxied response — the streamed upstream reply would otherwise drop it.
  const sessionCookie = event.node.res.getHeader('set-cookie')

  // Force `Accept: application/json` so auth/validation errors render as JSON (see
  // docs/transport-modes.md). Opt out to forward the browser's Accept for non-JSON routes.
  const accept = apiForceJson ? 'application/json' : (getRequestHeader(event, 'accept') ?? '')
  // Inject the bearer server-side; strip inbound Cookie/Authorization + spoofable
  // headers; `streamRequest` pipes the body through instead of buffering it.
  return proxyRequest(event, base + query, {
    streamRequest: true,
    headers: {
      'accept': accept,
      'cookie': '',
      'authorization': access ? `Bearer ${access}` : '',
      'x-forwarded-for': getRequestIP(event, { xForwardedFor: false }) ?? '',
      ...SPOOFABLE_FORWARDING,
    },
    // Not a cookie/cache passthrough: strip upstream Set-Cookie, restore the rotated session,
    // and (opt-in) re-emit only allow-listed app-API cookies. Keep it out of shared caches.
    onResponse(ev) {
      const upstream = toCookieArray(ev.node.res.getHeader('set-cookie'))
      ev.node.res.removeHeader('set-cookie')
      const keep = toCookieArray(sessionCookie) // the rotated session cookie (if any)
      // Opt-in passthrough: forward only allow-listed names — and NEVER the sealed session
      // cookie, whatever the list says (an upstream must not be able to overwrite it).
      if (forwardSetCookie.length) {
        for (const cookie of upstream) {
          const name = cookieName(cookie)
          if (name !== LUKK_SESSION_COOKIE && forwardSetCookie.includes(name)) keep.push(cookie)
        }
      }
      if (keep.length) ev.node.res.setHeader('set-cookie', keep)
      ev.node.res.setHeader('cache-control', 'private, no-store')
    },
  })
})

/**
 * Read-only unseal of the sealed BFF session (access + refresh), for the bearer.
 * Unlike h3's `useSession`, this NEVER mints or slides the cookie — an expired,
 * tampered, or anonymous request yields `{}` and queues no `Set-Cookie` (which would
 * otherwise collide with the streamed proxy response). Local + never returns the
 * refresh token to a client — it's used only to decide whether to rotate.
 */
async function readSession(event: H3Event, password: string): Promise<TokenSession> {
  const sealed = getCookie(event, LUKK_SESSION_COOKIE)
  if (!sealed || !password) return {}
  try {
    const unsealed = await unsealSession(event, { password, name: LUKK_SESSION_COOKIE }, sealed)
    return (unsealed as { data?: TokenSession }).data ?? {}
  }
  catch {
    // Tampered, expired, or wrong-secret seal → treat as no session.
    return {}
  }
}

/** Normalize a `Set-Cookie` header value (string | string[] | number | undefined) to an array. */
function toCookieArray(value: number | string | string[] | undefined): string[] {
  if (value === undefined) return []
  return Array.isArray(value) ? [...value] : [String(value)]
}

/** The cookie name from a `Set-Cookie` string (the part before the first `=`). */
function cookieName(setCookie: string): string {
  const eq = setCookie.indexOf('=')
  return eq === -1 ? '' : setCookie.slice(0, eq).trim()
}
