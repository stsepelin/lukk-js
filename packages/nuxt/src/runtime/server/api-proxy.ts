import { defineEventHandler, getRequestHeader, proxyRequest, setResponseStatus, useSession } from 'h3'
import { useRuntimeConfig } from '#imports'
import { LUKK_BFF_PREFIX, confirmationHeaderName, isResolvableBase, isSessionCookieName, sessionCookieName, signedOutCookieName } from '../shared'
import { accessExpired } from './access-token'
import { hopByHopHeaders, isForeignOrigin, isForeignSubresource, reachesLukk, reportProxyFailure, rejectUnresolvedTarget, resolveTarget, SPOOFABLE_FORWARDING, viaHeader, visitorIp } from './proxy-utils'
import { sessionEnded, sessionKey } from './ended-sessions'
import { logoutNoted, withholdSignedOut } from './logout-note'
import { revokeDroppedSession } from './revoke-dropped'
import { readSealedSession, sessionCookie as sessionCookieOptions, sessionSeal } from './sealed-session'
import { refreshOnce, type TokenSession } from './refresh'

/**
 * Optional BFF app-API proxy. Forwards same-origin `${apiPath}/**` to the fixed
 * `apiTarget` (your Laravel API), injecting the lukk access token from the sealed
 * session server-side — so the browser authenticates without ever holding a token.
 *
 * Security (SSRF/CSRF containment, header stripping) is documented in
 * docs/transport-modes.md.
 */
/** RFC 9110 §7.6.1 connection-specific response fields, which end at this hop. */
const HOP_BY_HOP_RESPONSE = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-connection', 'trailer', 'transfer-encoding', 'upgrade'])

export default defineEventHandler(async (event) => {
  const { apiPath, apiTarget, apiForceJson, baseURL, sessionPassword, apiForwardSetCookie, cookieSecure, cookieNamespace, clientIpHeader, sessionMaxAge } = useRuntimeConfig(event).lukk as {
    apiPath: string
    apiTarget: string
    apiForceJson: boolean
    baseURL: string
    sessionPassword: string
    apiForwardSetCookie?: string[]
    cookieSecure?: boolean
    cookieNamespace?: string
    clientIpHeader?: string
    sessionMaxAge?: number
  }
  // Stryker disable next-line ArrayDeclaration: the list is only read as `.length` and `.includes(name)`, so a placeholder entry changes nothing unless an upstream sets a cookie named after Stryker's own sentinel.
  const forwardSetCookie = apiForwardSetCookie ?? []
  // Resolved through the shared guard: a post-build runtime override could otherwise name an
  // invalid or proxy-owned header and break every request here (see `confirmationHeaderName`).
  const confirmationHeader = confirmationHeaderName((useRuntimeConfig(event).public.lukk as { confirmationHeader?: string }).confirmationHeader)
  const clientIp = visitorIp(event, clientIpHeader)
  // Secure/`__Host-` in prod + dev-https, relaxed for dev-http (see module cookieSecure); the name's
  // prefix and the Secure attribute both derive from this one `secure` — they can't diverge.
  const secure = cookieSecure !== false
  const sessionName = sessionCookieName(secure, cookieNamespace)

  // CSRF, and the GET half of it: this proxy injects the bearer from the sealed session, so another site's
  // — or a same-site sibling's — `<img>`, fetch or frame pointed here was answered as the visitor. Only a
  // top-level navigation (a link in an email to a download) still passes; see `isForeignSubresource`.
  if (isForeignOrigin(event, secure) || isForeignSubresource(event)) {
    setResponseStatus(event, 403)
    return { message: 'Cross-origin request rejected.' }
  }

  // The query comes from the RAW request target. h3 percent-decodes the path half of `event.path`
  // (leaving the query as sent), so an encoded `?` in a path segment (`/a%3Fb`) arrives there as a
  // real one — splitting `event.path` on it moved part of the path into an invented query. h3 appends
  // the query verbatim, so the decoded path is whatever precedes it. (`node.req.url` is always set
  // by h3; the fallback only keeps a request without one behaving as it did.)
  const raw = event.node.req.url ?? event.path
  const queryAt = raw.indexOf('?')
  const query = queryAt === -1 ? '' : raw.slice(queryAt)
  const path = event.path.slice(0, event.path.length - query.length)

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
  // Stryker disable next-line StringLiteral: `resolveTarget` strips a leading `/` from the subpath, so '/' and '' build the identical URL — and its other use, the escape log, is unreachable for a subpath that cannot escape.
  const subpath = path.slice(apiPath.length) || '/'
  const base = resolveTarget(apiTarget, subpath)
  if (!base) return rejectUnresolvedTarget(event, apiTarget, 'lukk `api.target`', subpath)

  // Never lukk's own routes. They answer with credentials — a token pair from `/login`, a step-up
  // token from `/confirm-password` — and this proxy streams bodies through untouched, so in the
  // documented layout (`api.target` = the app, `baseURL` = the same app under `/auth`) a same-origin
  // script could POST `/api/auth/login` and read the tokens BFF mode exists to keep server-side. The
  // auth proxy is the only way to them. Decided on the resolved URL, the way lukk's router will see
  // it, not on the request path. An unresolvable `baseURL` fails closed: there is no telling then.
  if (!isResolvableBase(baseURL)) return rejectUnresolvedTarget(event, baseURL, 'lukk `baseURL`', subpath)
  if (reachesLukk(base, baseURL)) {
    setResponseStatus(event, 404)
    return { message: 'Not found.' }
  }

  // Read the sealed session READ-ONLY first (never minting or sliding a cookie — h3's
  // useSession would re-seal a fresh *empty* session for an expired/tampered seal,
  // which then collides with the streamed response). Only when the injected access
  // token has actually lapsed do we open the read-write session to rotate — and there
  // the seal is valid, so its id is restored (no re-mint).
  // Not while a logout the browser noted is being finished (see `finish-logout`): the visitor asked to be
  // signed out, and a page rendering right now must not show that account's data.
  const sealed = logoutNoted(event, secure, cookieNamespace) ? {} : await readSealedSession(event, sessionPassword, sessionName)
  let access = sealed.access
  // Set when this request re-seals the session, so the response can check it again at the last moment.
  let resealed: (() => Promise<boolean>) | null = null
  let rotatedRefresh: string | undefined
  if (access && sealed.refresh && accessExpired(access)) {
    const session = await useSession<TokenSession>(event, {
      password: sessionPassword,
      name: sessionName,
      cookie: sessionCookieOptions(secure, sessionMaxAge),
      // h3 otherwise accepts a sealed session from the `x-<name>-session` REQUEST HEADER in
      // preference to the cookie — an auth channel outside `__Host-`, Secure, HttpOnly and
      // SameSite=Strict. Nothing here reads it (readSealedSession is cookie-only), but leaving the
      // door open on a session primitive is not worth the two words it costs to close.
      sessionHeader: false,
      // Every seal written gets a lifetime (see `sessionSeal`).
      seal: sessionSeal(sessionMaxAge),
    })
    // Proactive refresh: rotate ONCE (shared single-flight with the BFF proxy) so a
    // streamed request isn't spent on a guaranteed 401. A revoked session still
    // surfaces naturally: the refresh fails → null → the stale bearer → upstream 401.
    //
    // Not for a session a sign-in replaced or a logout ended while this request was out: re-sealing it
    // would put the previous session back in the browser. The stale bearer then 401s upstream.
    const ended = () => sessionEnded(sessionKey(session))
    // Stryker disable next-line ObjectLiteral: `pair` is read only for truthiness on this path, and an absent key is as falsy as `null`.
    const { pair } = await ended() ? { pair: null } : await refreshOnce(session, baseURL, clientIp)
    if (pair && !(await ended())) {
      await session.update(pair)
      access = pair.access
      rotatedRefresh = pair.refresh
      resealed = ended
    }
    else if (pair) {
      revokeDroppedSession(event, pair, baseURL, clientIp)
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
  // `sendProxy` swallows a failed fetch into an opaque 502 with the reason only on `error.cause`,
  // which Nuxt doesn't surface — so a proxy that cannot reach the upstream, or that builds an
  // illegal request, presents as a silent total outage. Surfacing the cause once turns that into a
  // one-line diagnosis. Logged, never handled: the 502 still propagates unchanged.
  return await proxyRequest(event, base + query, {
    streamRequest: true,
    // Never follow an upstream 3xx server-side — don't re-emit the injected bearer to a
    // redirect host (CWE-918/200). What comes back instead depends on the runtime: a browser-style
    // opaque redirect (status 0), or — Node's undici, workerd, Deno — the real 3xx with its headers.
    // onResponse turns either into a clean 502 (matching the BFF proxy).
    fetchOptions: { redirect: 'manual' },
    // h3 merges the bag below OVER the client's headers, so blanking is the only way to override one — and
    // a blank is still a header: `Origin:` with no value is an Origin a CORS layer upstream sees as present
    // and judges, and `Cookie:` an empty cookie list. What this proxy blanked, it means to remove.
    fetch: (input, init) => globalThis.fetch(input, { ...init, headers: withoutBlanks(init?.headers) }),
    headers: {
      // FIRST, so a pathological `confirmationHeader` rename can never clobber a header set below.
      // Symmetric with `authorization`: the step-up token is a credential the browser must never
      // hold, so a client-set one is replaced — with the SERVER-held token when the session has one.
      // Blanking alone would have made an app-API route behind lukk's confirm middleware
      // unreachable; injecting makes it work the same way it does through the auth proxy, from the
      // sealed session rather than from whatever the browser claimed.
      [confirmationHeader.toLowerCase()]: sealed.confirmation ?? '',
      'accept': accept,
      // The app's origin is this proxy's to police; the upstream's CORS decision must not apply to it.
      'origin': '',
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
      // Stryker disable next-line StringLiteral: `'cookie'` is inert in this list — the bag already
      // set `cookie: ''` above, so blanking it writes the identical value under the identical key,
      // and no input can tell the two apart. (Line-granular, so the other five names are ignored
      // with it; each stays pinned by the Connection-strip test, which asserts that the value this
      // proxy set still reaches the upstream when the client names that header in `Connection`.)
      ...hopByHopHeaders(event, ['authorization', 'cookie', 'x-forwarded-for', 'via', 'accept', 'content-type', confirmationHeader]),
    },
    // Not a cookie/cache passthrough: strip upstream Set-Cookie, restore the rotated session,
    // and (opt-in) re-emit only allow-listed app-API cookies. Keep it out of shared caches.
    async onResponse(ev, response) {
      // `sendProxy` copies the upstream's response headers — Set-Cookie included — BEFORE this
      // runs, so the strip and the rotated-cookie restore below must happen on every path. The
      // 3xx branch used to return first, and `redirect: 'manual'` yields a real 3xx WITH headers on
      // Node (undici answers `type: 'basic'`, status 302, Location and Set-Cookie intact), workerd and
      // Deno alike — so the upstream's Set-Cookie (possibly a forged lukk session, defeating the guard
      // below) reached the browser and a just-rotated session cookie was dropped, stranding it on a
      // consumed refresh token.
      const redirected = response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)

      // Headers that describe the upstream hop, not this response. CORS: this proxy serves the app's own
      // origin, so the upstream's Access-Control-* would let ITS policy decide who reads this origin —
      // one echoing `*.example.com` with credentials let a sibling subdomain read authenticated GETs,
      // the bearer injected here. Hop-by-hop (RFC 9110 §7.6.1), including any the upstream's own
      // `Connection` names: they end at this hop.
      // Stryker disable next-line StringLiteral: equivalent — the fallback only ever reaches `includes`, and no response header is named after it.
      const named = (response.headers.get('connection') ?? '').split(',').map(name => name.trim().toLowerCase())
      for (const [name] of response.headers) {
        if (name.startsWith('access-control-') || HOP_BY_HOP_RESPONSE.has(name) || named.includes(name)) ev.node.res.removeHeader(name)
      }

      const upstream = toCookieArray(ev.node.res.getHeader('set-cookie'))
      ev.node.res.removeHeader('set-cookie')
      // The rotated session cookie (if any) — unless a sign-in or logout ended that session while the
      // upstream was answering. This is the last point before the headers go out.
      const replaced = (await resealed?.()) === true
      if (replaced) revokeDroppedSession(event, { access, refresh: rotatedRefresh }, baseURL, clientIp)
      // Nor the signed-out cookie a logout this request finished queued (see `finish-logout`), if a sign-in
      // replaced that session while the upstream was answering.
      // Both cookies, not just the marker: the queue may also hold a session the logout's renewal
      // re-sealed, and this response is finalised after the upstream answered — late enough to land over
      // the sign-in that replaced it and put the browser back on the previous account.
      const ours = [signedOutCookieName(secure, cookieNamespace), sessionName]
      const dropLogoutCookies = await withholdSignedOut(event)
      const keep = replaced
        ? []
        : toCookieArray(sessionCookie).filter(cookie => !dropLogoutCookies || !ours.includes(cookieName(cookie)))
      // Opt-in passthrough: forward only allow-listed names — and NEVER a lukk sealed session
      // cookie (this app's OR a co-hosted app's, whatever the list says); an upstream must not be
      // able to set/overwrite any lukk session.
      // Stryker disable next-line ConditionalExpression: with no allow-list `includes(name)` is false
      // for every name, so the loop is already a no-op — this guard is a fast path, not a rule, and
      // dropping it cannot change what is forwarded. (Line-granular, so the `false` direction is
      // ignored with it; it stays pinned by the allow-list test, which needs this block to run.)
      if (forwardSetCookie.length) {
        for (const cookie of upstream) {
          const name = cookieName(cookie)
          if (!isSessionCookieName(name) && forwardSetCookie.includes(name)) keep.push(cookie)
        }
      }
      if (keep.length) ev.node.res.setHeader('set-cookie', keep)
      ev.node.res.setHeader('cache-control', 'private, no-store')
      // Served on the APP's origin: a body sniffed as HTML there runs with the app's cookies in scope and
      // the BFF one request away. Never let the browser second-guess the declared type.
      ev.node.res.setHeader('x-content-type-options', 'nosniff')
      // And a DOCUMENT from the API — an error page, an upload served inline, an SVG — gets an opaque
      // origin, so whatever script it carries cannot act as the app. Not for JSON, which no browser renders
      // as a document of this origin (and Firefox's viewer breaks under a sandbox), nor a PDF, which a
      // viewer isolated from the page shows and Chromium refuses to show sandboxed at all. Added to the
      // upstream's own policy, never over it: every CSP header is enforced (CSP3 §4.1), so it only narrows.
      // Stryker disable next-line StringLiteral: equivalent — the fallback only reaches the test, and no replacement string starts with `application/json` or `application/pdf`.
      if (!UNSANDBOXED_TYPE.test(response.headers.get('content-type') ?? '')) {
        ev.node.res.setHeader('content-security-policy', [...toCookieArray(ev.node.res.getHeader('content-security-policy')), 'sandbox'])
      }
      // And per visitor: `no-store` keeps it out of a conforming cache, `Vary: Cookie` out of one that
      // keys on the URL alone regardless (RFC 9111 §4.1). Added to what the upstream varies on, not over it.
      const vary = String(ev.node.res.getHeader('vary') ?? '')
      if (!/(?:^|,)\s*(?:cookie|\*)\s*(?:,|$)/i.test(vary)) ev.node.res.setHeader('vary', vary ? `${vary}, Cookie` : 'Cookie')

      // A trusted JSON upstream shouldn't 3xx — reject it rather than stream an empty 200 (or a
      // Location) downstream. Last, so the header hygiene above has already run.
      if (redirected) {
        ev.node.res.statusCode = 502
        ev.node.res.removeHeader('location')
      }
    },
  }).catch((error: unknown) => {
    // Once per distinct target+cause — an outage fails every request identically, and this file's
    // sibling reporters already learned that lesson (see `reportUnusableBase`).
    reportProxyFailure(base, error)

    throw error
  })
})

/** JSON (`application/json`, `application/*+json`) and PDF — the response types left unsandboxed. */
const UNSANDBOXED_TYPE = /^application\/(?:(?:[\w.-]+\+)?json|pdf)\s*(?:;|$)/i

/** The outgoing headers minus every one left blank — see the `fetch` option above. */
function withoutBlanks(init: HeadersInit | undefined): Headers {
  const headers = new Headers(init)
  for (const [name, value] of [...headers]) {
    if (value === '') headers.delete(name)
  }
  return headers
}

/** Normalize a header value (string | string[] | number | undefined) to an array. */
function toCookieArray(value: number | string | string[] | undefined): string[] {
  if (value === undefined) return []
  return Array.isArray(value) ? [...value] : [String(value)]
}

/** The cookie name from a `Set-Cookie` string (the part before the first `=`). */
function cookieName(setCookie: string): string {
  const eq = setCookie.indexOf('=')
  // Stryker disable next-line StringLiteral: the name is only matched against lukk's own cookie names, `isSessionCookieName`, and the allow-list — a nameless cookie and a sentinel are both "no match" unless the allow-list literally contains the empty string.
  return eq === -1 ? '' : setCookie.slice(0, eq).trim()
}
