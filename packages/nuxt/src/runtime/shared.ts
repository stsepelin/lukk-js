// Public runtime constants — one source of truth for the proxy mount + session name.

/** The same-origin path the BFF proxy is mounted at. Reserved by lukk-nuxt. */
export const LUKK_BFF_PREFIX = '/api/_lukk'

/**
 * The sealed server-side token session cookie name (BFF mode). The `__Host-` prefix
 * makes the browser enforce its hardening (Secure, Path=/, no Domain), which requires
 * HTTPS — so it's the name used whenever the cookie is Secure.
 */
export const LUKK_SESSION_COOKIE = '__Host-lukk-session'

/**
 * The session cookie name for a given Secure setting. `__Host-` REQUIRES the Secure
 * attribute, so it's dropped (plain `lukk-session`) when Secure is off — otherwise the
 * browser rejects the cookie. Whether the cookie is Secure is decided once, at build,
 * by the module (`lukk.session.cookieSecure`): on in production, on under `nuxi dev
 * --https`, off only for `nuxi dev` over plain http (a browser drops a Secure cookie
 * even on localhost).
 */
export function sessionCookieName(secure: boolean): string {
  return secure ? LUKK_SESSION_COOKIE : 'lukk-session'
}
