import type { H3Event } from 'h3'
import { isTokenPair } from 'lukk-core'
import { defineEventHandler, getCookie, getRequestHeader, readRawBody, setResponseStatus, useSession } from 'h3'
import { useRuntimeConfig } from '#imports'
import { LUKK_BFF_PREFIX, sessionCookieName } from '../shared'
import { isForeignOrigin, resolveTarget } from './proxy-utils'
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
  const { baseURL, sessionPassword, cookieSecure } = useRuntimeConfig(event).lukk as { baseURL: string, sessionPassword: string, cookieSecure?: boolean }
  const method = event.method

  // Secure/`__Host-` in prod + dev-https, relaxed for dev-http (see module cookieSecure).
  // Default to secure when unset so a misread config can never silently drop Secure.
  const secure = cookieSecure !== false
  const sessionName = sessionCookieName(secure)
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
  if (!target) {
    setResponseStatus(event, 400)
    return { message: 'Invalid path.' }
  }

  const rawBody = method === 'GET' || method === 'HEAD' ? undefined : await readRawBody(event)

  function callLukk(access: string | undefined): Promise<Response> {
    const headers: Record<string, string> = { Accept: 'application/json' }
    const contentType = getRequestHeader(event, 'content-type')
    if (contentType) headers['Content-Type'] = contentType
    // Confirmation token is held server-side too — never trust one from the browser.
    if (sealed.confirmation) headers['X-Lukk-Confirmation'] = sealed.confirmation
    if (access) headers.Authorization = `Bearer ${access}`
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
    const pair = await refreshOnce(s, baseURL)
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
