// Public runtime constants — one source of truth for the proxy mount + session name.

/** The same-origin path the BFF proxy is mounted at. Reserved by lukk-nuxt. */
export const LUKK_BFF_PREFIX = '/api/_lukk'

/**
 * Whether a proxy base (`baseURL`, `api.target`) is one the SERVER can actually resolve and
 * fetch: absolute, with an http(s) scheme. Shared by the module's build-time validation and
 * `resolveTarget`, so "accepted at build" and "resolvable at request time" can't drift.
 *
 * The scheme check is not redundant: `new URL('localhost:3000/auth')` SUCCEEDS, parsing
 * `localhost:` as the scheme with a null origin — so a base that merely forgot its `https://`
 * passes a bare `new URL()` and then fails deep in the proxy.
 */
export function isResolvableBase(base: string): boolean {
  try {
    const { protocol } = new URL(base)
    return protocol === 'http:' || protocol === 'https:'
  }
  catch {
    return false
  }
}

/**
 * Mask any `user:pass@` in a base before it reaches a log. These messages surface in CI build logs
 * (often publicly readable), in the `nuxt dev` error overlay, and in server logs.
 *
 * The match is greedy up to the LAST `@` before the path, matching how the URL parser splits
 * userinfo — stopping at the first would leave a password fragment behind for `//u:p@ss@host/`.
 */
export function redactCredentials(value: string): string {
  return value.replace(/\/\/[^/\s]*@/, '//***@')
}

/**
 * The default sealed server-side token session cookie name (BFF mode, Secure, no namespace).
 * The `__Host-` prefix makes the browser enforce its hardening (Secure, Path=/, no Domain),
 * which requires HTTPS — so it's the name used whenever the cookie is Secure and no per-app
 * `session.name` is configured.
 */
export const LUKK_SESSION_COOKIE = '__Host-lukk-session'

/**
 * The session cookie name for a given Secure setting and optional per-app namespace.
 *
 * `__Host-` REQUIRES the Secure attribute, so it's dropped (plain `lukk-session`) when Secure is
 * off — otherwise the browser rejects the cookie. Whether the cookie is Secure is decided once,
 * at build, by the module (`lukk.session.cookieSecure`): on in production, on under `nuxi dev
 * --https`, off only for `nuxi dev` over plain http (a browser drops a Secure cookie even on
 * localhost).
 *
 * `name` namespaces the cookie so multiple lukk apps can share a host — cookies are scoped by
 * host, not port, so dev on `localhost:3000` + `:3001` (or same-domain path routing) otherwise
 * clobber each other's session. Unset keeps today's names:
 *   sessionCookieName(true)           -> '__Host-lukk-session'
 *   sessionCookieName(false)          -> 'lukk-session'
 *   sessionCookieName(true, 'admin')  -> '__Host-lukk-admin-session'
 *   sessionCookieName(false, 'admin') -> 'lukk-admin-session'
 */
export function sessionCookieName(secure: boolean, name?: string): string {
  const ns = name ? `-${name}` : ''
  return secure ? `__Host-lukk${ns}-session` : `lukk${ns}-session`
}

/**
 * The BFF's logout note: a short-lived cookie the BROWSER sets when `logout()` is called, so the next
 * request — the page load a navigation makes before the logout request has even gone out — tells the
 * server to finish that logout before rendering. Named like the session cookie it belongs to (and
 * `__Host-` where that one is, so a sibling subdomain cannot plant it).
 */
export function logoutCookieName(secure: boolean, name?: string): string {
  const ns = name ? `-${name}` : ''
  return secure ? `__Host-lukk${ns}-logout` : `lukk${ns}-logout`
}

/**
 * The server's answer to that note: this browser's logout is done, so the page it rides knows it is signed
 * out without asking. Its own cookie, not a value on the note — the browser's own logout response clears
 * the note whenever it lands, which would take this with it — and not the page payload, which a cached
 * page would carry to every visitor.
 */
export function signedOutCookieName(secure: boolean, name?: string): string {
  const ns = name ? `-${name}` : ''
  return secure ? `__Host-lukk${ns}-signed-out` : `lukk${ns}-signed-out`
}

/**
 * Whether a cookie name is one of lukk's own BFF cookies for ANY app — the sealed session, and the two
 * that drive a logout (an upstream that could set those would sign a visitor out, or keep them in) — the
 * default or any namespace,
 * Secure or dev-http. The app-API proxy uses this so it never forwards a lukk sealed session cookie
 * to the browser, even a co-hosted sibling app's, whatever the `api.forwardSetCookie` allow-list says.
 */
export function isSessionCookieName(name: string): boolean {
  return /^(__Host-)?lukk-([\w.-]+-)?(session|logout|signed-out)$/.test(name)
}

/** The default step-up header, and the fallback when a configured one is unusable. */
export const LUKK_CONFIRMATION_HEADER = 'X-Lukk-Confirmation'

const HEADER_TOKEN = /^[a-z0-9!#$%&'*+.^_`|~-]+$/i

/**
 * Headers a browser can set that an upstream may read as coming from its edge proxy, blanked before
 * the app-API proxy forwards.
 *
 * Two families, both spoofable and both consequential:
 *
 * The upstream decides which of these to trust (Laravel's `TrustProxies` honours a configured mask
 * and CDNs read their own), so any one arriving from the BROWSER is an attempt to choose the
 * upstream's idea of `$request->ip()` — the value that becomes a rate-limit and lockout key. The
 * proxy asserts `x-forwarded-for` itself and blanks the rest.
 *
 * Blanked rather than deleted: `proxyRequest` merges over the inbound headers, and an empty string
 * replaces where an absent key would leave the client's value in place.
 */
export const SPOOFABLE_FORWARDING: Record<string, string> = {
  'x-forwarded-host': '',
  'x-forwarded-proto': '',
  'x-forwarded-port': '',
  'x-forwarded-server': '',
  // The path/scheme family. `x-forwarded-prefix` is the one with teeth: Symfony honours
  // `HEADER_X_FORWARDED_PREFIX` from a trusted proxy and applies it to the base path every generated
  // URL is built on, so a browser-set value rewrites the links the app emails and renders. The others
  // are the same idea through different front ends, and `x-original-url`/`x-rewrite-url` are the
  // IIS/ARR spelling that has repeatedly been used to reach paths a front-end ACL believed it blocked.
  'x-forwarded-prefix': '',
  'x-forwarded-scheme': '',
  'x-forwarded-ssl': '',
  'x-forwarded-uri': '',
  'x-original-url': '',
  'x-rewrite-url': '',
  'x-forwarded': '',
  'x-original-forwarded-for': '',
  'x-http-forwarded-for': '',
  'forwarded': '',
  'x-real-ip': '',
  'x-client-ip': '',
  'x-remote-ip': '',
  'x-remote-addr': '',
  'x-originating-ip': '',
  'client-ip': '',
  'true-client-ip': '',
  'cf-connecting-ip': '',
  'cf-connecting-ipv6': '',
  'cf-pseudo-ipv4': '',
  'fastly-client-ip': '',
  'x-cluster-client-ip': '',
  'x-azure-clientip': '',
  'x-azure-socketip': '',
  'fly-client-ip': '',
  'x-vercel-forwarded-for': '',
  'x-vercel-proxied-for': '',
  'x-appengine-user-ip': '',
  'do-connecting-ip': '',
  'oai-host': '',
}

/**
 * Header names the proxies set themselves. A step-up header colliding with one of these breaks
 * something either way, and silently: in the app-API proxy the confirmation token is overwritten by
 * the fixed header, so step-up stops working; in the auth proxy the token is written FIRST and would
 * clobber `Accept`/`Content-Type`, so lukk misreads the request instead.
 *
 * Built FROM the map the app-API proxy blanks, never copied from it: a hand-kept copy here had fallen
 * behind — the `x-forwarded-prefix` family and `via` were accepted as step-up header names, and the
 * proxy then blanked or overwrote the token on every request.
 */
const RESERVED_HEADERS = new Set([
  'accept', 'authorization', 'content-type', 'cookie', 'host', 'x-forwarded-for', 'via',
  ...Object.keys(SPOOFABLE_FORWARDING),
])

/**
 * Names the transport itself refuses or discards (the Fetch standard's forbidden request-header names,
 * which cover the hop-by-hop ones). Not a silent loss of step-up but a total outage: undici throws on
 * `connection`, `keep-alive`, `content-length`, `expect` and the like even with an empty value, and the
 * app-API proxy always sets the step-up header — so every proxied request answered 502. A browser in
 * direct mode drops them instead, and step-up fails with nothing pointing at the setting.
 */
const TRANSPORT_HEADERS = new Set([
  'accept-charset', 'accept-encoding', 'access-control-request-headers', 'access-control-request-method',
  'connection', 'content-length', 'cookie2', 'date', 'dnt', 'expect', 'keep-alive', 'origin', 'referer',
  'set-cookie', 'te', 'trailer', 'transfer-encoding', 'upgrade',
])
const TRANSPORT_PREFIX = /^(proxy|sec)-/

/**
 * `x-<session cookie name>-session`: h3 reads a sealed session from it, so the app-API proxy blanks it.
 * Named per app, and the namespace may be any header-token characters (`module.ts` only warns about
 * the unusual ones), so the pattern takes the whole token alphabet rather than `isSessionCookieName`'s.
 */
const SESSION_REQUEST_HEADER = /^x-(__host-)?lukk-([a-z0-9!#$%&'*+.^_`|~-]+-)?session-session$/

/** Whether a configured step-up header is a valid token and not one the proxies or the transport own. */
export function isUsableConfirmationHeader(name: string): boolean {
  const lower = name.toLowerCase()
  return HEADER_TOKEN.test(lower)
    && !RESERVED_HEADERS.has(lower)
    && !TRANSPORT_HEADERS.has(lower)
    && !TRANSPORT_PREFIX.test(lower)
    && !SESSION_REQUEST_HEADER.test(lower)
}

/**
 * The step-up header the proxies actually use, falling back to the default when the effective value
 * is unusable.
 *
 * The module rejects a bad value at build, but that only covers `nuxt.config`: this is public
 * runtime config, so `NUXT_PUBLIC_LUKK_CONFIRMATION_HEADER` can replace it after the build. An
 * invalid name there would make `Headers.set` throw on EVERY proxied request — taking the whole app
 * API down over a step-up misconfiguration — so degrade to the default and lose only step-up.
 */
export function confirmationHeaderName(configured?: string): string {
  return configured && isUsableConfirmationHeader(configured) ? configured : LUKK_CONFIRMATION_HEADER
}

/**
 * Did the server reject the caller as not signed in (401/403)?
 *
 * Anything else — a 429, a 5xx, a network failure with no status at all — means the answer is
 * unknown, NOT that nobody is signed in. Treating those as signed-out shows a login prompt to a
 * user whose session is perfectly valid. Reads `statusCode` as well as `status` because ofetch
 * errors carry the former and `LukkError` the latter.
 */
export function isAuthRejection(error: unknown): boolean {
  const e = error as { statusCode?: number, status?: number } | null | undefined
  const status = e?.statusCode ?? e?.status
  return status === 401 || status === 403
}
