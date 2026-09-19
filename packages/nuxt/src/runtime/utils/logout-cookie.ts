/**
 * The BFF logout note, from the browser's side: see `logoutCookieName`.
 *
 * Written the moment `logout()` is called, so it rides the very next request — a navigation's page load
 * included, which reaches the server before a `pagehide` send could. The server then ends the session
 * before rendering. Every response that seals a NEW session clears it, which is the FIRST thing keeping
 * a note from ending a sign-in that came after it: from another tab, a server-side flow, anywhere. It is
 * not the only thing — the logout also stands down on a sign-in recorded since it was asked for, which
 * does read a clock and `localStorage` (see `signedInSince`).
 *
 * `SameSite=Strict`, one minute, and `Secure` exactly when the name carries `__Host-`. Not `HttpOnly` —
 * the browser writes it. Its PRESENCE is the message the server acts on; the value carries the moment the
 * logout was asked for, which the page that finishes the note needs and cannot otherwise know. Without it
 * that page used its own load time, and a sign-in already on the wire — sent before the load, landing
 * after — could never count as "since", so the note ended the session that sign-in had just created.
 */
const MAX_AGE_S = 60
/**
 * Below this, the value is not an epoch-ms timestamp at all — it is the bare `1` notes carried before
 * they held a time (a browser mid-upgrade still has one), which would otherwise read as 1970 and make
 * every sign-in since count as "after". A note may legitimately be much older than its minute, since
 * renewing carries the original time forward, so there is no upper bound to pair with this.
 */
const PLAUSIBLE_EPOCH_MS = 1_600_000_000_000

// No `typeof document` guards below: on the server `document` is undeclared, and the ReferenceError lands in
// the same `catch` that handles cookies being disabled — one path, not two.
function write(name: string, value: string, maxAge: number): void {
  const secure = name.startsWith('__Host-') ? '; Secure' : ''
  try { document.cookie = `${name}=${value}; Path=/; Max-Age=${maxAge}; SameSite=Strict${secure}` }
  catch { /* no document, or cookies disabled: no note */ }
}

export function setLogoutCookie(name: string, at: number = Date.now()): void {
  // Never past now, for the same reason the sign-in record isn't: a future note would outlive its minute
  // and the page that renews it must not be able to walk it forward.
  write(name, String(Math.max(1, Math.min(Math.trunc(at), Date.now()))), MAX_AGE_S)
}

/**
 * When was the logout this note stands for asked for?
 *
 * `undefined` for a note that predates the timestamp, or one whose value has been tampered with — the
 * caller then falls back to its own clock, which is what every note did before.
 */
export function logoutNoteAt(name: string, now = Date.now()): number | undefined {
  let raw: string | undefined
  // Stryker disable next-line OptionalChaining: equivalent — without it a missing note throws inside this try, and `raw` stays undefined exactly as `?.` leaves it.
  try { raw = document.cookie.split(';').map(part => part.trim()).find(part => part.startsWith(`${name}=`))?.slice(name.length + 1) }
  catch { /* no document, or cookies disabled: `raw` stays undefined, and reads as no timestamp below */ }
  const at = Number(raw)
  // No tolerance ahead of now, for the same reason `signedInSince` has none: the write side clamps to the
  // present, so a future value is never one of ours. Unknown here is safe — the caller falls back to its
  // own clock, and a logout that can't prove a sign-in came after it simply sends.
  if (!Number.isInteger(at) || at < PLAUSIBLE_EPOCH_MS || at > now) return undefined
  return at
}

export function clearLogoutCookie(name: string): void {
  write(name, '', 0)
}

/** Is this cookie there — the pending note, or the server's signed-out answer to it? */
export function hasLogoutCookie(name: string): boolean {
  try { return document.cookie.split(';').some(part => part.trim().startsWith(`${name}=`)) }
  catch { return false }
}
