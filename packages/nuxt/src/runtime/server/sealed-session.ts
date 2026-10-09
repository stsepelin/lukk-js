import type { H3Event, SessionConfig } from 'h3'
import { getCookie, unsealSession } from 'h3'
import type { TokenSession } from './utils/refresh'

/**
 * Read-only unseal of the sealed BFF token session (access + refresh + confirmation).
 *
 * Unlike h3's `useSession`, this NEVER creates or slides the session cookie: it reads the request
 * cookie and unseals it in place (`unsealSession` is pure). So it is safe on an unauthenticated
 * request and alongside a streamed/proxied response — it queues no `Set-Cookie` (which would
 * otherwise collide with the streamed reply). A missing cookie, an absent password, or a
 * tampered/expired/wrong-secret seal all yield `{}`.
 *
 * Server-only, and it returns the refresh token — never hand that back to a client. It is
 * deliberately NOT in `server/utils` (so it is not auto-imported); consumers get only the
 * access-token view via `getLukkAccessToken`.
 */
export async function readSealedSession(event: H3Event, password: string | undefined, name: string): Promise<TokenSession> {
  return (await readSealedSessionWithId(event, password, name)).data
}

/**
 * The same read, with h3's session id — the identity a session sealed before `sid` existed is recorded
 * under when it ends. Still read-only: nothing is minted or slid.
 */
export async function readSealedSessionWithId(event: H3Event, password: string | undefined, name: string): Promise<{ id?: string, data: TokenSession }> {
  const sealed = getCookie(event, name)
  if (!sealed || !password) return { data: {} }
  try {
    const unsealed = await unsealSession(event, { password, name }, sealed) as { id?: string, data?: TokenSession }
    return { id: unsealed.id, data: unsealed.data ?? {} }
  }
  catch {
    return { data: {} }
  }
}

/** lukk's own default `refresh_ttl`: past it the refresh token inside a seal is dead anyway. */
export const DEFAULT_SESSION_MAX_AGE = 30 * 24 * 60 * 60

/**
 * The iron options every sealed session is WRITTEN with: a lifetime, in seconds.
 *
 * Without one iron seals with no expiry, so a seal copied out of a browser unsealed forever — long after
 * the session it held was over. iron stamps the expiry into the seal itself and every unseal checks it
 * (`unsealSession`, `useSession`), so the write is the whole of it; the readers need no option to honour
 * it. Per seal, not per session: a refresh re-seals with a fresh lifetime, and lukk's own refresh family
 * bounds the session. (A seal written before this existed carries no expiry and is honoured until it is
 * next re-sealed — a refresh within one access-token lifetime of its next use.)
 *
 * Partial on purpose: h3 spreads this OVER iron's defaults, so only `ttl` changes.
 */
export function sessionSeal(maxAge: number | undefined): SessionConfig['seal'] {
  return { ttl: (maxAge ?? DEFAULT_SESSION_MAX_AGE) * 1000 } as SessionConfig['seal']
}

/**
 * The cookie every sealed session is WRITTEN with: \`__Host-\`-safe, and persistent for the seal's own
 * lifetime. With no Max-Age it was a session cookie, dropped when the browser closed, so a BFF user was
 * signed out on every restart while a direct-mode one, holding lukk's persistent refresh cookie, was not.
 * Max-Age rather than h3's \`maxAge\` option: that becomes an Expires counted from the session's FIRST
 * creation, while Max-Age restarts on every write, as the seal does.
 */
export function sessionCookie(secure: boolean, maxAge: number | undefined): { sameSite: 'strict', secure: boolean, httpOnly: true, path: '/', maxAge: number } {
  return { sameSite: 'strict', secure, httpOnly: true, path: '/', maxAge: maxAge ?? DEFAULT_SESSION_MAX_AGE }
}
