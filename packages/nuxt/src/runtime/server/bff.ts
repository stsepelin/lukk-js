import { isTokenPair } from 'lukk-core'
import { defineEventHandler, getRequestHeader, readRawBody, setResponseStatus, useSession } from 'h3'
import { useRuntimeConfig } from '#imports'

interface TokenSession {
  access?: string
  refresh?: string
  confirmation?: string
}

/**
 * The BFF proxy. The browser calls `/api/_lukk/*`; this handler attaches the
 * access token (and step-up confirmation token) from a sealed, server-side
 * session, proxies to the real lukk URL, refreshes server-side on a 401, and
 * **strips every minted credential out of the response** — so the browser only
 * ever holds the opaque session cookie, never a token.
 */

// Per-session single-flight: collapse a burst of concurrent 401-refreshes into
// one real `/refresh` call, so a rotated refresh token is never replayed.
const inflightRefresh = new Map<string, Promise<TokenSession | null>>()

export default defineEventHandler(async (event) => {
  const { baseURL, sessionPassword } = useRuntimeConfig(event).lukk as { baseURL: string, sessionPassword: string }
  const method = event.method

  // CSRF: a state-changing request whose Origin doesn't match this host is rejected.
  // The proxy is same-origin by definition; cross-site forms/fetches carry the
  // session cookie but a foreign Origin, so this closes the CSRF hole the sealed
  // cookie alone doesn't.
  if (method !== 'GET' && method !== 'HEAD') {
    const origin = getRequestHeader(event, 'origin')
    const host = getRequestHeader(event, 'host')
    if (origin && originHost(origin) !== host) {
      setResponseStatus(event, 403)
      return { message: 'Cross-origin request rejected.' }
    }
  }

  const session = await useSession<TokenSession>(event, {
    password: sessionPassword,
    name: 'lukk-session',
    cookie: { sameSite: 'strict', secure: true, httpOnly: true, path: '/' },
  })

  // Resolve + contain the upstream URL: it must stay same-origin as lukk and under
  // its base path. Defeats traversal / authority-smuggling (`..`, `%2e%2e`, `//`, `@`).
  const subpath = event.path.replace(/^\/api\/_lukk/, '').split('?')[0] || '/'
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
    if (session.data.confirmation) headers['X-Lukk-Confirmation'] = session.data.confirmation
    if (access) headers.Authorization = `Bearer ${access}`
    return fetch(target!, { method, headers, body: rawBody })
  }

  let res = await callLukk(session.data.access)

  if (res.status === 401 && session.data.refresh) {
    const pair = await refreshOnce(session, baseURL)
    if (pair) {
      await session.update(pair)
      res = await callLukk(pair.access)
    }
    else {
      await session.clear()
    }
  }

  const text = await res.text()
  const data: unknown = text ? safeParse(text) : undefined

  // Capture + strip minted tokens (login / 2FA / passkey login / refresh).
  if (res.ok && isTokenPair(data)) {
    await session.update({ access: data.access_token, refresh: data.refresh_token ?? session.data.refresh })
    return { ok: true, expires_in: data.expires_in }
  }

  // Capture + strip a step-up confirmation token — keep it server-side as well.
  if (res.ok && isConfirmation(data)) {
    await session.update({ confirmation: data.confirmation_token })
    return { ok: true }
  }

  if (subpath === '/logout') await session.clear()

  setResponseStatus(event, res.status)
  return data ?? text
})

/** Single-flight the server-side refresh per session, returning the new token pair. */
function refreshOnce(session: { id?: string, data: TokenSession }, baseURL: string): Promise<TokenSession | null> {
  const key = session.id ?? ''
  const existing = inflightRefresh.get(key)
  if (existing) return existing
  const run = rawRefresh(session.data.refresh!, baseURL).finally(() => inflightRefresh.delete(key))
  inflightRefresh.set(key, run)
  return run
}

async function rawRefresh(refreshToken: string, baseURL: string): Promise<TokenSession | null> {
  const target = resolveTarget(baseURL, '/refresh')!
  const res = await fetch(target, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ refresh_token: refreshToken }),
  })
  if (!res.ok) return null
  const pair = await res.json() as { access_token: string, refresh_token?: string }
  return { access: pair.access_token, refresh: pair.refresh_token ?? refreshToken }
}

/**
 * Build the upstream URL and assert it stays under lukk's base (same origin AND
 * path prefix). The origin is baked into `prefix`, so a cross-origin or traversal
 * target — including encoded `%2e%2e`, which `new URL` normalizes — fails the one
 * `startsWith` check. Defeats SSRF / authority-smuggling.
 */
function resolveTarget(base: string, subpath: string): string | null {
  try {
    const b = new URL(base)
    const prefix = `${b.origin}${b.pathname.replace(/\/$/, '')}/`
    const target = new URL(`${base.replace(/\/$/, '')}/${subpath.replace(/^\//, '')}`)
    if (!`${target.origin}${target.pathname}/`.startsWith(prefix)) return null
    return target.toString()
  }
  catch {
    return null
  }
}

function originHost(origin: string): string | null {
  try { return new URL(origin).host }
  catch { return null }
}

function isConfirmation(value: unknown): value is { confirmation_token: string } {
  return typeof value === 'object' && value !== null
    && typeof (value as { confirmation_token?: unknown }).confirmation_token === 'string'
}

function safeParse(text: string): unknown {
  try { return JSON.parse(text) }
  catch { return text }
}
