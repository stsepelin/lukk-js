// Public runtime constants — one source of truth for the proxy mount + session name.

/** The same-origin path the BFF proxy is mounted at. Reserved by lukk-nuxt. */
export const LUKK_BFF_PREFIX = '/api/_lukk'

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
