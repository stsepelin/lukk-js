import type { H3Event } from 'h3'
import { isTokenPair } from 'lukk-core'
import { defineEventHandler, getCookie, getRequestHeader, readRawBody, setResponseStatus, useSession } from 'h3'
import { useRuntimeConfig } from '#imports'
import { LUKK_BFF_PREFIX, confirmationHeaderName, sessionCookieName } from '../shared'
import { isForeignOrigin, rejectUnresolvedTarget, resolveTarget, visitorIp } from './proxy-utils'
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

  const clientIp = visitorIp(event, clientIpHeader)
  // The option mirrors lukk's own `confirm.header`, so a rename has to reach lukk too — hardcoding
  // the default here would silently break step-up for anyone who changed it on both sides.
  const confirmationHeader = confirmationHeaderName((useRuntimeConfig(event).public.lukk as { confirmationHeader?: string }).confirmationHeader)
  const rawBody = method === 'GET' || method === 'HEAD' ? undefined : await readRawBody(event)

  function callLukk(access: string | undefined): Promise<Response> {
    const headers: Record<string, string> = { Accept: 'application/json' }
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

  // The live refresh token: `sealed.refresh` until an in-request refresh rotates it.
  let currentRefresh = sealed.refresh
  let res = await callLukk(sealed.access)

  if (res.status === 401 && sealed.refresh) {
    const s = await session()
    const pair = await refreshOnce(s, baseURL, clientIp)
    if (pair) {
      await s.update(pair)
      warnIfSessionTooLarge(s)
      currentRefresh = pair.refresh
      res = await callLukk(pair.access)
    }
    else {
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
  return data ?? text
})

/** Open the read-write sealed session (h3 mints the cookie if absent — call only when writing). */
function openSession(event: H3Event, password: string, name: string, cookie: SessionCookieOptions) {
  return useSession<TokenSession>(event, { password, name, cookie })
}

function isConfirmation(value: unknown): value is { confirmation_token: string } {
  return typeof value === 'object' && value !== null
    && typeof (value as { confirmation_token?: unknown }).confirmation_token === 'string'
}

function safeParse(text: string): unknown {
  try { return JSON.parse(text) }
  catch { return text }
}
