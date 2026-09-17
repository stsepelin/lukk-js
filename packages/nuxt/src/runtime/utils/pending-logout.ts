/**
 * A per-tab note that a logout was started and hasn't finished.
 *
 * A page that navigates away right after calling `logout()` sends it on `pagehide` — but a browser fires
 * that only once the NEXT page's response has arrived, and that request still carried the live session:
 * in BFF mode the next page rendered signed in. The note survives the navigation (`sessionStorage` is per
 * tab), so the next page finishes the logout before restoring anything.
 *
 * It holds when it was written, and is honoured only briefly: it exists for the page load right after
 * the logout. An old note — a logout that failed and was left, a tab duplicated later — would otherwise
 * end whatever session the tab holds by then, possibly one signed in since.
 *
 * Nor is it honoured past a sign-in in ANY tab. The note outlives the page, so a tab that logged out,
 * left for another site and came back finished the logout on its return — with the shared cookie, by
 * then another tab's newer sign-in, which it ended. A sign-in isn't announced to a page that no longer
 * exists, so it leaves its time in `localStorage` (shared by every tab), and a note older than that is moot.
 * The time the sign-in was SENT: one sent before the logout was asked for ends up behind it in the lock
 * queue on a page that stays, and the page that left and came back must agree. An app that clears
 * `localStorage` loses the record, and a note written before that sign-in is honoured again.
 *
 * Both keys are scoped to the app's base, like its lock and channel: two apps sharing an origin keep
 * separate session cookies, and one's sign-in must neither cancel nor be ended by the other's logout.
 *
 * `sessionStorage` can throw (storage disabled, some private modes); then there's simply no note.
 */
const noteKey = (scope = '/') => `lukk:logging-out:${scope}`
const signedInKey = (scope = '/') => `lukk:signed-in-at:${scope}`

/** Long enough for the navigation that follows a logout; short enough not to outlive its purpose. */
export const PENDING_LOGOUT_TTL_MS = 60_000

function storage(): Storage | undefined {
  try { return typeof sessionStorage === 'undefined' ? undefined : sessionStorage }
  catch { return undefined }
}

function shared(): Storage | undefined {
  try { return typeof localStorage === 'undefined' ? undefined : localStorage }
  catch { return undefined }
}

/** Note a logout asked for at `now`. The next page's `logout()` that finishes it doesn't note again — see useLukkAuth. */
export function notePendingLogout(scope?: string, now = Date.now()): void {
  try { storage()?.setItem(noteKey(scope), String(now)) }
  catch { /* no note */ }
}

/** Drop the note — or with `upTo`, only one written no later than that: a logout asked for after it stands. */
export function clearPendingLogout(scope?: string, upTo?: number): void {
  try {
    const store = storage()
    if (upTo !== undefined && Number(store?.getItem(noteKey(scope))) > upTo) return
    store?.removeItem(noteKey(scope))
  }
  catch { /* nothing to clear */ }
}

/** A sign-in in any tab, sent at `sentAt`: every note written after that is moot. */
export function noteSignIn(scope: string | undefined, sentAt: number): void {
  try { shared()?.setItem(signedInKey(scope), String(sentAt)) }
  catch { /* no record */ }
}

/** When the logout still standing was asked for — or `undefined`: none, too old, or moot since a sign-in. */
export function pendingLogoutAt(scope?: string, now = Date.now()): number | undefined {
  try {
    const noted = Number(storage()?.getItem(noteKey(scope)))
    return Number.isFinite(noted) && noted > 0 && now - noted < PENDING_LOGOUT_TTL_MS && !signedInSince(scope, noted) ? noted : undefined
  }
  catch { return undefined }
}

export function hasPendingLogout(scope?: string, now = Date.now()): boolean {
  return pendingLogoutAt(scope, now) !== undefined
}

/** Was a sign-in sent, in any tab, at or after `at`? */
export function signedInSince(scope: string | undefined, at: number): boolean {
  return lastSignIn(scope) >= at
}

// A record that can't be read says nothing about a later sign-in, so the note stands.
function lastSignIn(scope: string | undefined): number {
  try { return Number(shared()?.getItem(signedInKey(scope))) || 0 }
  catch { return 0 }
}
