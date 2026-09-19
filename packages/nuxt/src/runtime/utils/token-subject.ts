/**
 * The `sub` claim of a JWT — **decoded, not verified**. A client-side hint only: it tells this tab which
 * account a token it was just handed belongs to, never whether to trust it.
 *
 * `atob`, not `Buffer`: this runs in the browser. Returns undefined for anything that is not a JWT with
 * a string or numeric subject (the BFF's tokenless refresh shape included).
 */
export function tokenSubject(jwt: unknown): string | undefined {
  return claim(jwt, 'sub')
}

/**
 * The `fid` claim — the session (refresh-token family) a lukk access token belongs to. Same caveats: a
 * hint, and undefined where a custom `TokenIssuer` leaves it out.
 */
export function tokenFamily(jwt: unknown): string | undefined {
  return claim(jwt, 'fid')
}

function claim(jwt: unknown, name: 'sub' | 'fid'): string | undefined {
  const payload = typeof jwt === 'string' ? jwt.split('.')[1] : undefined
  // Stryker disable next-line ConditionalExpression: equivalent — without it `payload.replace` throws inside the try, which returns undefined too. Kept so a missing segment is not decoded as an error path.
  if (!payload) return undefined

  try {
    const value = (JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as Record<string, unknown>)[name]
    return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined
  }
  // Stryker disable next-line BlockStatement: equivalent — an emptied catch falls off the end of the function, which returns undefined as well.
  catch {
    return undefined
  }
}
