import { defineEventHandler, getRequestHeader, proxyRequest, setResponseStatus, useSession } from 'h3'
import { useRuntimeConfig } from '#imports'
import { LUKK_BFF_PREFIX, confirmationHeaderName, isSessionCookieName, sessionCookieName } from '../shared'
import { accessExpired } from './access-token'
import { hopByHopHeaders, isForeignOrigin, rejectUnresolvedTarget, resolveTarget, SPOOFABLE_FORWARDING, viaHeader, visitorIp } from './proxy-utils'
import { readSealedSession } from './sealed-session'
import { refreshOnce, type TokenSession } from './utils/refresh'

/**
 * Optional BFF app-API proxy. Forwards same-origin `${apiPath}/**` to the fixed
 * `apiTarget` (your Laravel API), injecting the lukk access token from the sealed
 * session server-side — so the browser authenticates without ever holding a token.
 *
 * Security (SSRF/CSRF containment, header stripping) is documented in
 * docs/transport-modes.md.
 */
export default defineEventHandler(async (event) => {
  const { apiPath, apiTarget, apiForceJson, baseURL, sessionPassword, apiForwardSetCookie, cookieSecure, cookieNamespace, clientIpHeader } = useRuntimeConfig(event).lukk as {
    apiPath: string
    apiTarget: string
    apiForceJson: boolean
    baseURL: string
    sessionPassword: string
    apiForwardSetCookie?: string[]
    cookieSecure?: boolean
    cookieNamespace?: string
    clientIpHeader?: string
  }
  const forwardSetCookie = apiForwardSetCookie ?? []
  // Resolved through the shared guard: a post-build runtime override could otherwise name an
  // invalid or proxy-owned header and break every request here (see `confirmationHeaderName`).
  const confirmationHeader = confirmationHeaderName((useRuntimeConfig(event).public.lukk as { confirmationHeader?: string }).confirmationHeader)
  const clientIp = visitorIp(event, clientIpHeader)
  // Secure/`__Host-` in prod + dev-https, relaxed for dev-http (see module cookieSecure); the name's
  // prefix and the Secure attribute both derive from this one `secure` — they can't diverge.
  const secure = cookieSecure !== false
  const sessionName = sessionCookieName(secure, cookieNamespace)

  if (isForeignOrigin(event, secure)) {
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
  const subpath = path.slice(apiPath.length) || '/'
  const base = resolveTarget(apiTarget, subpath)
  if (!base) return rejectUnresolvedTarget(event, apiTarget, 'lukk `api.target`', subpath)

  // Read the sealed session READ-ONLY first (never minting or sliding a cookie — h3's
  // useSession would re-seal a fresh *empty* session for an expired/tampered seal,
  // which then collides with the streamed response). Only when the injected access
  // token has actually lapsed do we open the read-write session to rotate — and there
  // the seal is valid, so its id is restored (no re-mint).
  const sealed = await readSealedSession(event, sessionPassword, sessionName)
  let access = sealed.access
  if (access && sealed.refresh && accessExpired(access)) {
    const session = await useSession<TokenSession>(event, {
      password: sessionPassword,
      name: sessionName,
      cookie: { sameSite: 'strict', secure, httpOnly: true, path: '/' },
      // h3 otherwise accepts a sealed session from the `x-<name>-session` REQUEST HEADER in
      // preference to the cookie — an auth channel outside `__Host-`, Secure, HttpOnly and
      // SameSite=Strict. Nothing here reads it (readSealedSession is cookie-only), but leaving the
      // door open on a session primitive is not worth the two words it costs to close.
      sessionHeader: false,
    })
    // Proactive refresh: rotate ONCE (shared single-flight with the BFF proxy) so a
    // streamed request isn't spent on a guaranteed 401. A revoked session still
    // surfaces naturally: the refresh fails → null → the stale bearer → upstream 401.
    const { pair } = await refreshOnce(session, baseURL, clientIp)
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
    // Never follow an upstream 3xx server-side — don't re-emit the injected bearer to a
    // redirect host (CWE-918/200). undici returns an opaque response instead of following;
    // onResponse turns that into a clean 502 (matching the BFF proxy) rather than the empty
    // 200 h3 would otherwise sanitize a status-0 response into.
    fetchOptions: { redirect: 'manual' },
    headers: {
      // FIRST, so a pathological `confirmationHeader` rename can never clobber a header set below.
      // Symmetric with `authorization`: the step-up token is a credential the browser must never
      // hold, so a client-set one is replaced — with the SERVER-held token when the session has one.
      // Blanking alone would have made an app-API route behind lukk's confirm middleware
      // unreachable; injecting makes it work the same way it does through the auth proxy, from the
      // sealed session rather than from whatever the browser claimed.
      [confirmationHeader.toLowerCase()]: sealed.confirmation ?? '',
      'accept': accept,
      'cookie': '',
      'authorization': access ? `Bearer ${access}` : '',
      // The visitor when a trusted `clientIpHeader` is set, else our socket address — this proxy has
      // always asserted something, and the socket is first-hand fact about this hop. Read straight
      // off the socket rather than via `getRequestIP`: that consults `event.context.clientAddress`
      // BEFORE honouring `xForwardedFor: false`, so any middleware populating it from a header
      // would silently reinstate spoofing. (On non-Node presets the mock socket is empty and this
      // yields '' — there, `clientIpHeader` is the only way the upstream learns the caller.)
      // `x-forwarded-for` is deliberately NOT in SPOOFABLE_FORWARDING: the spread must not blank it,
      // and h3 REPLACES the client's own header with this value rather than appending to it.
      'x-forwarded-for': clientIp || event.node.req.socket?.remoteAddress || '',
      // RFC 9110 §7.6.3: a proxy adds itself to Via. A pseudonym, not the internal hostname.
      'via': viaHeader(event),
      // h3 will read a sealed session from `x-<cookie name>-session` unless told not to (see the
      // `sessionHeader: false` on every useSession call). Blank it on the way upstream too, so the
      // app API can never be handed one either.
      [`x-${sessionName.toLowerCase()}-session`]: '',
      ...SPOOFABLE_FORWARDING,
      // Last, so it can blank anything the client named in `Connection` (RFC 9110 §7.6.1) — but
      // never the headers this proxy sets itself, or a client could use `Connection` to strip its
      // own `authorization` and the step-up token on the way through.
      ...hopByHopHeaders(event, ['authorization', 'cookie', 'x-forwarded-for', 'via', 'accept', 'content-type', confirmationHeader]),
    },
    // Not a cookie/cache passthrough: strip upstream Set-Cookie, restore the rotated session,
    // and (opt-in) re-emit only allow-listed app-API cookies. Keep it out of shared caches.
    onResponse(ev, response) {
      // `sendProxy` copies the upstream's response headers — Set-Cookie included — BEFORE this
      // runs, so the strip and the rotated-cookie restore below must happen on every path. The
      // 3xx branch used to return first: harmless on Node, where undici filters an opaque redirect
      // down to zero headers, but on workerd/Deno `redirect: 'manual'` yields a real 3xx WITH
      // headers — there the upstream's Set-Cookie (possibly a forged lukk session, defeating the
      // guard below) reached the browser and a just-rotated session cookie was dropped, stranding
      // it on a consumed refresh token.
      const redirected = response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)

      const upstream = toCookieArray(ev.node.res.getHeader('set-cookie'))
      ev.node.res.removeHeader('set-cookie')
      const keep = toCookieArray(sessionCookie) // the rotated session cookie (if any)
      // Opt-in passthrough: forward only allow-listed names — and NEVER a lukk sealed session
      // cookie (this app's OR a co-hosted app's, whatever the list says); an upstream must not be
      // able to set/overwrite any lukk session.
      if (forwardSetCookie.length) {
        for (const cookie of upstream) {
          const name = cookieName(cookie)
          if (!isSessionCookieName(name) && forwardSetCookie.includes(name)) keep.push(cookie)
        }
      }
      if (keep.length) ev.node.res.setHeader('set-cookie', keep)
      ev.node.res.setHeader('cache-control', 'private, no-store')

      // A trusted JSON upstream shouldn't 3xx — reject it rather than stream an empty 200 (or a
      // Location) downstream. Last, so the header hygiene above has already run.
      if (redirected) {
        ev.node.res.statusCode = 502
        ev.node.res.removeHeader('location')
      }
    },
  })
})

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
