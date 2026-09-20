/**
 * DIRECT mode's per-tab note that a logout was started and hasn't finished. (BFF mode notes it in a
 * cookie the server reads — see `logout-cookie`.)
 *
 * A page that navigates away right after calling `logout()` sends it on `pagehide` — but a browser fires
 * that only once the NEXT page's response has arrived, and may not deliver it at all. The note survives
 * the navigation (`sessionStorage` is per tab), so the next page finishes the logout before restoring
 * anything.
 *
 * It names the session it was for — the access token's `fid` (its refresh-token family) — and the next
 * page ends only THAT one: it restores first, and logs out if the session it got is the same. The
 * cookie is shared by every tab, so by then it may hold a newer sign-in — from another tab, an SSO
 * callback, anything — and a note that couldn't tell them apart ended it.
 *
 * Honoured only briefly: it exists for the page load right after the logout.
 *
 * Without a family — `logout()` called before any token was known, or a custom `TokenIssuer` that leaves
 * `fid` out — the note falls back to time: it is moot once a sign-in is sent after it, in any tab. A
 * sign-in leaves the time it was SENT in `localStorage` for that. An app that clears `localStorage`, or a
 * sign-in that doesn't go through lukk-js, isn't seen by that fallback.
 *
 * Both keys are scoped to the app's base, like its lock and channel: two apps sharing an origin keep
 * separate sessions, and one's sign-in must neither cancel nor be ended by the other's logout.
 *
 * Storage can throw (disabled, some private modes); then there's simply no note.
 */
const noteKey = (scope = '/') => `lukk:logging-out:${scope}`
const signedInKey = (scope = '/') => `lukk:signed-in-at:${scope}`

/** Long enough for the navigation that follows a logout; short enough not to outlive its purpose. */
export const PENDING_LOGOUT_TTL_MS = 60_000

export interface PendingLogout {
  /** When the logout was asked for. */
  at: number
  /** The session it was for, when known. */
  fid?: string
}

// Storage is touched directly, inside each caller's `try`: on the server it is undeclared, and where the
// browser blocks it, reading the global throws — both land in the same `catch` as a failed read or write.

/** Note a logout asked for at `now`, for the session `fid` if known. */
export function notePendingLogout(scope?: string, fid?: string, now = Date.now()): void {
  // `JSON.stringify` drops an undefined `fid`, so a note for an unknown session carries only `at`.
  try { sessionStorage.setItem(noteKey(scope), JSON.stringify({ at: now, fid })) }
  catch { /* no note */ }
}

/** Drop the note — or with `upTo`, only one written no later than that: a logout asked for after it stands. */
export function clearPendingLogout(scope?: string, upTo?: number): void {
  try {
    // Without `upTo` every note goes: nothing is later than `Infinity`.
    if ((readNote(sessionStorage.getItem(noteKey(scope)))?.at ?? 0) > (upTo ?? Infinity)) return
    sessionStorage.removeItem(noteKey(scope))
  }
  catch { /* nothing to clear */ }
}

/** A sign-in in any tab, sent at `sentAt`: every family-less note written after that is moot. */
export function noteSignIn(scope: string | undefined, sentAt: number): void {
  // Never backwards: a slow sign-in answering after a later one would otherwise move the record behind a
  // note written between them, and the next page load would honour that note and end the newer session.
  // Never forwards past now either — see `signedInSince`.
  const now = Date.now()
  try { localStorage.setItem(signedInKey(scope), String(Math.min(Math.max(sentAt, lastSignIn(scope)), now))) }
  catch { /* no record */ }
}

/**
 * The logout still standing, or `undefined`: none, too old — or, for one without a family, moot since a
 * sign-in. One WITH a family is never judged by time: the session it names settles it.
 */
export function readPendingLogout(scope?: string, now = Date.now()): PendingLogout | undefined {
  try {
    const note = readNote(sessionStorage.getItem(noteKey(scope)))
    // Bounded from BOTH ends. A note dated in the future — the clock moved back between writing and
    // reading it — has a negative age, so an upper bound alone honoured it forever, while `signedInSince`
    // disbelieved the equally-future sign-in record and nothing could stand it down.
    const age = now - note!.at
    if (!note || age < 0 || age >= PENDING_LOGOUT_TTL_MS) return undefined
    return note.fid !== undefined || !signedInSince(scope, note.at) ? note : undefined
  }
  // Stryker disable next-line BlockStatement: equivalent — an emptied catch falls off the end, which returns undefined too.
  catch { return undefined }
}

/** Was a sign-in sent, in any tab, at or after `at`? */
export function signedInSince(scope: string | undefined, at: number, now = Date.now()): boolean {
  const last = lastSignIn(scope)
  // A record in the future is not evidence of anything: the clock moved (an RTC correction, a restored
  // snapshot) or someone wrote it. Believing it would veto every logout from here on — the request is
  // never sent, while local state is cleared and the next page load restores the session it names.
  //
  // No tolerance window: `noteSignIn` clamps everything IT writes to now, and every tab shares one clock,
  // so a future record is never one of ours. A window here only ever admitted a forged one — which is a
  // standing veto on logging out, handed to any script on the origin.
  if (last > now) return false
  return last >= at
}

function readNote(raw: string | null | undefined): PendingLogout | undefined {
  try {
    const note = JSON.parse(raw ?? '') as Partial<PendingLogout> | null
    // Stryker disable next-line OptionalChaining: equivalent — for a stored `null`, `note.at` throws inside this try and reads as no note all the same.
    if (typeof note?.at !== 'number' || !(note.at > 0)) return undefined
    return typeof note.fid === 'string' ? { at: note.at, fid: note.fid } : { at: note.at }
  }
  // Stryker disable next-line BlockStatement: equivalent — an emptied catch falls off the end, which returns undefined too.
  catch { return undefined }
}

// A record that can't be read says nothing about a later sign-in, so the note stands.
function lastSignIn(scope: string | undefined): number {
  try { return Number(localStorage.getItem(signedInKey(scope))) || 0 }
  catch { return 0 }
}
