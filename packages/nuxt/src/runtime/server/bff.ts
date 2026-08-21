import type { H3Event } from 'h3'
import { isTokenPair } from 'lukk-core'
import { defineEventHandler, getCookie, getRequestHeader, readRawBody, setResponseHeader, setResponseStatus, useSession } from 'h3'
import { useRuntimeConfig } from '#imports'
import { LUKK_BFF_PREFIX, confirmationHeaderName, sessionCookieName } from '../shared'
import { isForeignOrigin, rejectUnresolvedTarget, resolveTarget, viaHeader, visitorIp } from './proxy-utils'
import { readSealedSession } from './sealed-session'
import { warnIfSessionTooLarge } from './session-size'
import { refreshOnce, type TokenSession } from './utils/refresh'

type SessionCookieOptions = { sameSite: 'strict', secure: boolean, httpOnly: true, path: '/' }

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
  if (isForeignOrigin(event)) {
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

  function callLukk(access: string | undefined): Promise<Response> {
    // This path builds its headers from scratch rather than forwarding the client's, so there is
    // nothing to strip — no hop-by-hop or spoofed forwarding header can reach the upstream. Via is
    // still owed: RFC 9110 §7.6.3 asks every forwarding intermediary to identify itself.
    const headers: Record<string, string> = { Accept: 'application/json', Via: viaHeader(event) }
    const contentType = getRequestHeader(event, 'content-type')
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
    return fetch(target!, { method, headers, body: rawBody, redirect: 'manual' })
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
    const { pair, expiresIn, retryable } = await refreshOnce(s, baseURL, clientIp)

    if (!pair) {
      if (!retryable) await s.clear()
      setResponseStatus(event, retryable ? 503 : 401)
      return { message: 'Unauthenticated.' }
    }

    await s.update(pair)
    warnIfSessionTooLarge(s)

    // The same shape the proxied token-pair capture returns — the browser never sees a token.
    return { ok: true, expires_in: expiresIn }
  }

  // The live refresh token: `sealed.refresh` until an in-request refresh rotates it.
  let currentRefresh = sealed.refresh
  let res = await callLukk(sealed.access)

  if (res.status === 401 && sealed.refresh) {
    const s = await session()
    const { pair, retryable } = await refreshOnce(s, baseURL, clientIp)
    if (pair) {
      await s.update(pair)
      warnIfSessionTooLarge(s)
      currentRefresh = pair.refresh
      res = await callLukk(pair.access)
    }
    // Clear ONLY on a definitive rejection. A throttled or failed refresh leaves the token valid, and
    // discarding the session there turns a transient 429 into an unrecoverable logout.
    else if (!retryable) {
      await s.clear()
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

  // Capture + strip minted tokens (login / 2FA / passkey login / refresh).
  if (res.ok && isTokenPair(data)) {
    const s = await session()
    await s.update({ access: data.access_token, refresh: data.refresh_token ?? currentRefresh })
    warnIfSessionTooLarge(s)
    return { ok: true, expires_in: data.expires_in }
  }

  // Capture + strip a step-up confirmation token — keep it server-side as well.
  if (res.ok && isConfirmation(data)) {
    const s = await session()
    await s.update({ confirmation: data.confirmation_token })
    warnIfSessionTooLarge(s)
    return { ok: true }
  }

  // Only clear an existing cookie — never mint one just to expire it.
  if (subpath === '/logout' && hasCookie) await (await session()).clear()

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
