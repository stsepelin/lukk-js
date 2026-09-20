import type { H3Event } from 'h3'
import { isTokenPair } from 'lukk-core'
import { defineEventHandler, getCookie, getRequestHeader, readRawBody, setResponseHeader, setResponseStatus, useSession } from 'h3'
import { useRuntimeConfig } from '#imports'
import { LUKK_BFF_PREFIX, confirmationHeaderName, sessionCookieName } from '../shared'
import { isForeignOrigin, rejectUnresolvedTarget, resolveTarget, viaHeader, visitorIp } from './proxy-utils'
import { endSession, newSessionId, sessionEnded, sessionKey, sessionReplaced, withholdSessionCookie } from './ended-sessions'
import { revokeDroppedSession } from './revoke-dropped'
import { readSealedSession } from './sealed-session'
import { warnIfSessionTooLarge } from './session-size'
import { refreshOnce, type TokenSession } from './utils/refresh'

type SessionCookieOptions = { sameSite: 'strict', secure: boolean, httpOnly: true, path: '/' }

/**
 * Sign-in routes never refresh and retry. They don't authenticate with the session they would replace,
 * so a 401 from one is the answer — lukk gives it for a passkey whose user no longer exists — not an
 * expired token. Retrying rotated the session being replaced and replayed an already-spent ceremony.
 * The same rule lukk-core applies in the browser.
 */
const SIGN_IN_PATHS = new Set(['/login', '/register', '/two-factor-challenge', '/passkeys/login'])

/**
 * The BFF proxy. The browser calls `/api/_lukk/*`; this handler attaches the
 * access token (and step-up confirmation token) from a sealed, server-side
 * session, proxies to the real lukk URL, refreshes server-side on a 401, and
 * **strips every minted credential out of the response** — so the browser only
 * ever holds the opaque session cookie, never a token.
 */
export default defineEventHandler(async (event) => {
  const { baseURL, sessionPassword, cookieSecure, cookieNamespace, clientIpHeader } = useRuntimeConfig(event).lukk as { baseURL: string, sessionPassword: string, cookieSecure?: boolean, cookieNamespace?: string, clientIpHeader?: string }
  const method = event.method

  // Secure/`__Host-` in prod + dev-https, relaxed for dev-http (see module cookieSecure). Default to
  // secure when unset so a misread config can never silently drop Secure. The name's `__Host-` prefix
  // and the Secure attribute both derive from this one `secure` — they can't diverge.
  const secure = cookieSecure !== false
  const sessionName = sessionCookieName(secure, cookieNamespace)
  const cookieOptions: SessionCookieOptions = { sameSite: 'strict', secure, httpOnly: true, path: '/' }

  // CSRF: reject a state-changing request riding the session cookie from a foreign origin.
  if (isForeignOrigin(event, secure)) {
    setResponseStatus(event, 403)
    return { message: 'Cross-origin request rejected.' }
  }

  // Read the sealed session READ-ONLY first, so an anonymous / failed-login / expired-or-tampered
  // request never mints an empty session cookie. The read-write session is opened lazily, only when
  // a request actually stores or clears tokens (login, refresh, confirmation, logout) — those low-
  // frequency write paths re-unseal once (a deliberate trade: no empty-cookie mint on the hot read
  // path is worth a second iron-open when auth state actually changes).
  const hasCookie = !!getCookie(event, sessionName)
  const sealed = await readSealedSession(event, sessionPassword, sessionName)
  let rwSession: ReturnType<typeof openSession> | null = null
  const session = () => (rwSession ??= openSession(event, sessionPassword, sessionName, cookieOptions))

  // Resolve + contain the upstream URL to same-origin-under-base (defeats traversal / authority-smuggling).
  const subpath = event.path.slice(LUKK_BFF_PREFIX.length).split('?')[0] || '/'
  const target = resolveTarget(baseURL, subpath)
  if (!target) return rejectUnresolvedTarget(event, baseURL, 'lukk `baseURL`', subpath)

  // lukk stamps `Cache-Control: no-store` on every credential-bearing response; this handler
  // returns a body and a status and drops the upstream's headers, so that directive was being
  // discarded and nothing replaced it. Authenticated GETs reachable through here — the passkey
  // inventory, the recovery-code count — then carried no directives and no `Vary`, which lets a
  // shared cache assign heuristic freshness (RFC 9111 §4.2.2) and key on the path alone. Set once,
  // for every path through this handler, matching what the app-API proxy already does.
  setResponseHeader(event, 'cache-control', 'private, no-store')
  setResponseHeader(event, 'vary', 'cookie')

  const clientIp = visitorIp(event, clientIpHeader)
  // The option mirrors lukk's own `confirm.header`, so a rename has to reach lukk too — hardcoding
  // the default here would silently break step-up for anyone who changed it on both sides.
  const confirmationHeader = confirmationHeaderName((useRuntimeConfig(event).public.lukk as { confirmationHeader?: string }).confirmationHeader)
  const rawBody = method === 'GET' || method === 'HEAD' ? undefined : await readRawBody(event)

  // A logout also presents the session's refresh token. lukk releases that accept one end the session
  // with it even when the access token has expired and a refresh is throttled or failing — and without
  // spending a rotation first. Older releases ignore the field and use the bearer, as before.
  const endsSession = subpath === '/logout'
  let logoutRefresh = sealed.refresh

  function callLukk(access: string | undefined): Promise<Response> {
    // This path builds its headers from scratch rather than forwarding the client's, so there is
    // nothing to strip — no hop-by-hop or spoofed forwarding header can reach the upstream. Via is
    // still owed: RFC 9110 §7.6.3 asks every forwarding intermediary to identify itself.
    const headers: Record<string, string> = { Accept: 'application/json', Via: viaHeader(event) }
    const contentType = endsSession ? 'application/json' : getRequestHeader(event, 'content-type')
    if (contentType) headers['Content-Type'] = contentType
    // Confirmation token is held server-side too — never trust one from the browser.
    if (sealed.confirmation) headers[confirmationHeader] = sealed.confirmation
    if (access) headers.Authorization = `Bearer ${access}`
    // lukk throttles login / forgot-password / two-factor-challenge on `$request->ip()`, which for a
    // BFF-proxied call is this server — collapsing every visitor onto one bucket. Strictly the
    // VISITOR's address: with no trusted header, or none on this request, we say nothing rather than
    // hand lukk our own address to use as a rate-limit key.
    if (clientIp) headers['X-Forwarded-For'] = clientIp
    // Never follow an upstream 3xx: a cross-origin redirect would re-emit the custom
    // X-Lukk-Confirmation header (undici keeps custom headers across redirects) and, on a
    // 307/308, the request body to the redirect host (CWE-918/200). Handled below.
    const body = endsSession ? JSON.stringify(logoutRefresh ? { refresh_token: logoutRefresh } : {}) : rawBody
    return fetch(target!, { method, headers, body, redirect: 'manual' })
  }

  // `/refresh` is SERVED here, never proxied. The browser holds an opaque cookie, not a refresh
  // token, so its body is empty — forwarding it asks lukk to rotate nothing and earns a 401. The
  // generic 401 branch below would then rotate the SEALED token and retry that same empty body:
  // one rotation burned per attempt, and still a 401. `restore()` on app load is exactly this call,
  // so in BFF mode it could never succeed, and two tabs reloading would replay a consumed token
  // past the grace window — the false family revoke this package exists to avoid.
  if (subpath === '/refresh') {
    // Read-only until we know there is something to rotate: opening the session would mint a
    // cookie for an anonymous caller.
    if (!sealed.refresh) {
      setResponseStatus(event, 401)
      return { message: 'Unauthenticated.' }
    }

    const s = await session()
    // Replaced by a sign-in, or ended by a logout, while this request was out. Neither rotate nor
    // write: the browser already holds the newer cookie. 409 rather than 401 — the visitor may well be
    // signed in, and the client reports it as "couldn't tell", whose retry carries the new cookie.
    const replaced = () => {
      setResponseStatus(event, 409)
      return { message: 'The session was replaced.' }
    }
    if (await sessionEnded(sessionKey(s))) return replaced()

    const { pair, expiresIn, retryable } = await refreshOnce(s, baseURL, clientIp)
    if (await sessionEnded(sessionKey(s))) {
      revokeDroppedSession(event, { access: pair?.access, refresh: pair?.refresh }, baseURL, clientIp)
      return replaced()
    }

    if (!pair) {
      if (!retryable) await s.clear()
      setResponseStatus(event, retryable ? 503 : 401)
      return { message: 'Unauthenticated.' }
    }

    await s.update(pair)
    warnIfSessionTooLarge(s)
    if (await sessionEnded(sessionKey(s))) {
      withholdSessionCookie(event.node.res, sessionName)
      revokeDroppedSession(event, pair, baseURL, clientIp)
      return replaced()
    }

    // The same shape the proxied token-pair capture returns — the browser never sees a token.
    return { ok: true, expires_in: expiresIn }
  }

  let res = await callLukk(sealed.access)
  // Rotated tokens this request re-sealed, if any — revoked should the session turn out to be replaced.
  let resealedTokens: TokenSession | undefined
  // A refresh that failed without lukk rejecting the token (a throttle, an outage): the session is live.
  let stillRefreshable = false

  if (res.status === 401 && sealed.refresh && !SIGN_IN_PATHS.has(subpath)) {
    const s = await session()
    // A session a sign-in replaced or a logout ended is neither rotated nor written — before the
    // refresh or after it — and the 401 goes back as it came. See the `/refresh` branch above.
    const ended = () => sessionEnded(sessionKey(s))
    // Except for a logout: it still renews an ended session's token — never writing it back — so that
    // lukk actually revokes it. Skipping it left a replaced session's family alive after the logout.
    const endingIt = subpath === '/logout'

    if (endingIt || !(await ended())) {
      const { pair, retryable } = await refreshOnce(s, baseURL, clientIp)
      if (pair && (endingIt || !(await ended()))) {
        logoutRefresh = pair.refresh
        // Seal AFTER the retried call, so a sign-in or logout during it is still seen — the response
        // carries this cookie only once that call is done. In `finally`: the refresh token has been
        // rotated either way, and a throw that skipped the write would strand the session on a consumed one.
        try { res = await callLukk(pair.access) }
        finally {
          if (!(await ended())) {
            await s.update(pair)
            warnIfSessionTooLarge(s)
            resealedTokens = pair
          }
          // The logout is about to revoke it itself.
          else if (!endingIt) {
            revokeDroppedSession(event, pair, baseURL, clientIp)
          }
        }
      }
      else if (pair) {
        revokeDroppedSession(event, pair, baseURL, clientIp)
      }
      // Clear ONLY on a definitive rejection. A throttled or failed refresh leaves the token valid, and
      // discarding the session there turns a transient 429 into an unrecoverable logout.
      else if (!pair && !retryable && !(await ended())) {
        await s.clear()
      }
      else if (!pair && retryable) {
        stillRefreshable = true
      }
    }
  }

  // A trusted JSON upstream shouldn't 3xx; with redirect:'manual' one surfaces as an
  // opaque response (status 0) — reject it rather than leak an empty/odd status downstream.
  if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
    setResponseStatus(event, 502)
    return { message: 'Upstream redirect rejected.' }
  }

  const text = await res.text()
  const data: unknown = text ? safeParse(text) : undefined

  // Reading the body can take as long as the upstream likes. A session re-sealed above that a sign-in or
  // logout ended meanwhile must not leave with this response — the last point before it does.
  if (rwSession && await sessionEnded(sessionKey(await rwSession))) {
    withholdSessionCookie(event.node.res, sessionName)
    revokeDroppedSession(event, resealedTokens ?? {}, baseURL, clientIp)
  }

  // Capture + strip minted tokens. Login / 2FA / passkey login / register only — `/refresh` is
  // served above and returns before reaching here, which is why wiping `confirmation` below is safe:
  // every pair that gets this far starts a NEW family, whereas a rotation keeps the old one and
  // `refreshOnce`'s merge-update deliberately preserves the step-up across it.
  if (res.ok && isTokenPair(data)) {
    const s = await session()
    // The session this request arrived with is over: a refresh still out for it must not write it back,
    // and lukk is told to end it now. Its cookie is about to be overwritten, so nothing could reach it
    // again — but it stayed live on lukk until it expired, and if this response never reaches the
    // browser (a dropped connection, an aborted fetch), the browser kept using it for as long.
    if (sealed.access || sealed.refresh) {
      await endSession(sessionKey(s), { replaced: true })
      revokeDroppedSession(event, sealed, baseURL, clientIp)
    }
    // `confirmation: undefined` too: a fresh token pair means a new SESSION, and a step-up earned by
    // the previous one must not carry over. Before confirmations were bound to the earning session
    // that was a silent no-op for the same subject; now it is a hard 423 on every step-up-gated
    // route, and the browser cannot clear the proxy's copy — `useLukkConfirmation.clear()` only
    // touches client state — so it would stick until `confirm.ttl` expired it.
    // No fallback to the refresh token the request arrived with: that belongs to the session being
    // REPLACED. Sealed under the new access token, the next refresh turned the browser back into the
    // previous account — and replayed a token lukk had already rotated, which reuse detection then
    // reported as theft. Without one, the new session simply ends when its access token does.
    await s.update({ access: data.access_token, refresh: data.refresh_token, confirmation: undefined, sid: newSessionId() })
    warnIfSessionTooLarge(s)
    return { ok: true, expires_in: data.expires_in }
  }

  // Capture + strip a step-up confirmation token — keep it server-side as well.
  if (res.ok && isConfirmation(data)) {
    const s = await session()
    // h3 re-seals the WHOLE session on any update — a confirmation answering after a sign-in or logout
    // would write the replaced session back. It also belongs to that session, so it is not recorded.
    if (await sessionEnded(sessionKey(s))) {
      setResponseStatus(event, 409)
      return { message: 'The session was replaced.' }
    }
    await s.update({ confirmation: data.confirmation_token })
    warnIfSessionTooLarge(s)
    return { ok: true }
  }

  // Clear only once the session is actually over: lukk ended it (2xx), or rejected credentials that can
  // no longer be renewed. A throttled logout (`429`), an outage, or a 401 whose refresh merely failed
  // leaves the session live on lukk — clearing the cookie then left it running with nothing pointing
  // at it, while the visitor believed they had logged out. The client is told, and can retry.
  const sessionOver = res.ok || ((res.status === 401 || res.status === 403) && !stillRefreshable)

  // Only clear an existing cookie — never mint one just to expire it.
  if (subpath === '/logout' && hasCookie && sessionOver) {
    const s = await session()
    const unsealed = Boolean(sealed.access || sealed.refresh)
    // Not for a session a sign-in has ALREADY replaced: the browser holds the newer cookie, and clearing
    // here would land after it and sign that newer session out — leaving it alive on lukk with nothing
    // pointing at it. The logout above still revoked this one upstream. (One a LOGOUT ended is cleared
    // again: a logout resent after its first response was lost carries the same, now dead, cookie.)
    if (!unsealed || !(await sessionReplaced(sessionKey(s)))) {
      // Only a session that unsealed: a forged or expired cookie still gets an h3 id, and recording
      // those let anyone flood the record past its bound and evict the entries that matter.
      if (unsealed) await endSession(sessionKey(s))
      await s.clear()
    }
  }

  setResponseStatus(event, res.status)

  // Fail CLOSED on the sensitive keys. The captures above are allow-list gated (`isTokenPair`
  // needs a string `access_token`), so a body that ALMOST matches — `{"access_token": null,
  // "refresh_token": "..."}` — skipped the strip and shipped a rotating refresh token to the
  // browser, the one thing BFF mode exists to prevent. Capture on a match; redact regardless.
  return redactCredentials(data) ?? text
})

/** Open the read-write sealed session (h3 mints the cookie if absent — call only when writing). */
function openSession(event: H3Event, password: string, name: string, cookie: SessionCookieOptions) {
  // `sessionHeader: false`: h3 otherwise accepts a sealed session from the `x-<name>-session`
  // REQUEST HEADER in preference to the cookie — an auth channel outside `__Host-`, Secure,
  // HttpOnly and SameSite=Strict. Nothing here reads it, but a session primitive shouldn't leave
  // a second door open.
  return useSession<TokenSession>(event, { password, name, cookie, sessionHeader: false })
}

function isConfirmation(value: unknown): value is { confirmation_token: string } {
  return typeof value === 'object' && value !== null
    && typeof (value as { confirmation_token?: unknown }).confirmation_token === 'string'
}

function safeParse(text: string): unknown {
  try { return JSON.parse(text) }
  catch { return text }
}

/**
 * Remove any credential key from a body that is being passed through verbatim.
 *
 * Deliberately a deny-list, unlike the capture gates above: a capture must be sure of the shape
 * before it stores something, but a REMOVAL must not depend on the shape being what we expected.
 */
function redactCredentials(data: unknown): unknown {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return data

  const body = data as Record<string, unknown>
  if (!('refresh_token' in body) && !('confirmation_token' in body)) return data

  const { refresh_token: _r, confirmation_token: _c, ...rest } = body

  return rest
}
