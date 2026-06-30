// Public runtime constants — one source of truth for the proxy mount + session name.

/** The same-origin path the BFF proxy is mounted at. Reserved by lukk-nuxt. */
export const LUKK_BFF_PREFIX = '/api/_lukk'

/**
 * The sealed server-side token session cookie (BFF mode). The `__Host-` prefix
 * makes the browser enforce its hardening (Secure, Path=/, no Domain) — so it
 * requires HTTPS (localhost is exempt in dev).
 */
export const LUKK_SESSION_COOKIE = '__Host-lukk-session'
