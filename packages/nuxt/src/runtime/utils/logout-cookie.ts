/**
 * The BFF logout note, from the browser's side: see `logoutCookieName`.
 *
 * Written the moment `logout()` is called, so it rides the very next request — a navigation's page load
 * included, which reaches the server before a `pagehide` send could. The server then ends the session
 * before rendering. Every response that seals a NEW session clears it, which is what keeps a note from
 * ending a sign-in that came after it: from another tab, a server-side flow, anywhere. No clock, no
 * `localStorage`.
 *
 * `SameSite=Strict`, one minute, and `Secure` exactly when the name carries `__Host-`. Not `HttpOnly` —
 * the browser writes it — and it carries nothing: its presence is the whole message.
 */
const MAX_AGE_S = 60

function write(name: string, value: string, maxAge: number): void {
  if (typeof document === 'undefined') return
  const secure = name.startsWith('__Host-') ? '; Secure' : ''
  try { document.cookie = `${name}=${value}; Path=/; Max-Age=${maxAge}; SameSite=Strict${secure}` }
  catch { /* cookies disabled: no note */ }
}

export function setLogoutCookie(name: string): void {
  write(name, '1', MAX_AGE_S)
}

export function clearLogoutCookie(name: string): void {
  write(name, '', 0)
}

/** Is this cookie there — the pending note, or the server's signed-out answer to it? */
export function hasLogoutCookie(name: string): boolean {
  if (typeof document === 'undefined') return false
  try { return document.cookie.split(';').some(part => part.trim().startsWith(`${name}=`)) }
  catch { return false }
}
