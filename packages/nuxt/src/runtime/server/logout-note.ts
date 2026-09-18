import type { H3Event } from 'h3'
import { getCookie } from 'h3'
import { logoutCookieName, signedOutCookieName } from '../shared'
import { sessionReplaced, withholdSessionCookie } from './ended-sessions'

/**
 * Is this request's visitor logging out, or logged out already — the browser's note, or the server's
 * answer to it (see `logoutCookieName`)? Then it is served as signed out, whether or not lukk has been
 * told yet: the visitor asked. Read from the request itself rather than a flag that middleware sets, so
 * it holds for the app's own server middleware (which runs first) and for a render's nested requests.
 *
 * Deliberately NOT under `server/utils`, so it is not auto-imported into the app.
 */
export function logoutNoted(event: H3Event, secure: boolean, namespace?: string): boolean {
  return Boolean(getCookie(event, logoutCookieName(secure, namespace)) ?? getCookie(event, signedOutCookieName(secure, namespace)))
}

/** What `finish-logout` queued for this request: the session it acted on, and the cookies it may have set. */
export interface EndedHere { key: string | undefined, marker: string, session: string }

/**
 * Must the signed-out cookie be held back from this response?
 *
 * Yes if a sign-in replaced that session while the response was being produced: the answer belongs to the
 * session that ended, and this browser now holds a newer one, whose page would then read as signed out.
 */
export async function withholdSignedOut(event: H3Event): Promise<boolean> {
  const ended = (event.context as { lukkEndedSession?: EndedHere } | undefined)?.lukkEndedSession
  return ended ? await sessionReplaced(ended.key) : false
}

/**
 * The last check before a response's headers go out — see `withholdSignedOut`. Safe to run more than once.
 *
 * Both cookies go, not just the answer. A logout whose renewal re-sealed the session queues that seal here
 * (the browser holds a refresh token this server has already spent), and this response is finalised long
 * before it lands: if a sign-in replaced the session meanwhile, the seal would arrive last and put the
 * browser back on the account it just left, with the newer session orphaned upstream.
 */
export async function withholdSignedOutCookie(event: H3Event): Promise<void> {
  const ended = (event.context as { lukkEndedSession?: EndedHere } | undefined)?.lukkEndedSession
  if (!ended || event.node.res.headersSent || !(await withholdSignedOut(event))) return
  withholdSessionCookie(event.node.res, ended.marker)
  withholdSessionCookie(event.node.res, ended.session)
}
