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
 * Whether a cookie name is a lukk BFF session cookie for ANY app — the default or any namespace,
 * Secure or dev-http. The app-API proxy uses this so it never forwards a lukk sealed session cookie
 * to the browser, even a co-hosted sibling app's, whatever the `api.forwardSetCookie` allow-list says.
 */
export function isSessionCookieName(name: string): boolean {
  return /^(__Host-)?lukk-([\w.-]+-)?session$/.test(name)
}
