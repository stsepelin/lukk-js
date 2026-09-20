/**
 * The `sub` claim of a JWT — **decoded, not verified**. A client-side hint only: it tells this tab which
 * account a token it was just handed belongs to, never whether to trust it.
 *
 * `atob`, not `Buffer`: this runs in the browser. Returns undefined for anything that is not a JWT with
 * a string or numeric subject (the BFF's tokenless refresh shape included).
 */
export function tokenSubject(jwt: unknown): string | undefined {
  const payload = typeof jwt === 'string' ? jwt.split('.')[1] : undefined
  if (!payload) return undefined

  try {
    const claims = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as { sub?: unknown }
    return typeof claims.sub === 'string' || typeof claims.sub === 'number' ? String(claims.sub) : undefined
  }
  catch {
    return undefined
  }
}
