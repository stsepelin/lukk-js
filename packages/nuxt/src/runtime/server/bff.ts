import type { H3Event } from 'h3'
import { isTokenPair } from 'lukk-core'
import { defineEventHandler, getCookie, getRequestHeader, readRawBody, setResponseStatus, unsealSession, useSession } from 'h3'
import { useRuntimeConfig } from '#imports'
import { LUKK_BFF_PREFIX, LUKK_SESSION_COOKIE } from '../shared'
import { isForeignOrigin, resolveTarget } from './proxy-utils'
import { refreshOnce, type TokenSession } from './utils/refresh'

// `__Host-`-compatible: Secure + Path=/ + no Domain (the prefix enforces these).
const SESSION_COOKIE = { sameSite: 'strict', secure: true, httpOnly: true, path: '/' } as const

/**
 * The BFF proxy. The browser calls `/api/_lukk/*`; this handler attaches the
 * access token (and step-up confirmation token) from a sealed, server-side
 * session, proxies to the real lukk URL, refreshes server-side on a 401, and
 * **strips every minted credential out of the response** — so the browser only
 * ever holds the opaque session cookie, never a token.
 */
export default defineEventHandler(async (event) => {
  const { baseURL, sessionPassword } = useRuntimeConfig(event).lukk as { baseURL: string, sessionPassword: string }
  const method = event.method

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
  const hasCookie = !!getCookie(event, LUKK_SESSION_COOKIE)
  const sealed = await readSealed(event, sessionPassword)
  let rwSession: ReturnType<typeof openSession> | null = null
  const session = () => (rwSession ??= openSession(event, sessionPassword))

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
    return fetch(target!, { method, headers, body: rawBody })
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
function openSession(event: H3Event, password: string) {
  return useSession<TokenSession>(event, { password, name: LUKK_SESSION_COOKIE, cookie: SESSION_COOKIE })
}

/** Read-only unseal of the sealed session — never mints or slides the cookie. */
async function readSealed(event: H3Event, password: string): Promise<TokenSession> {
  const sealed = getCookie(event, LUKK_SESSION_COOKIE)
  if (!sealed || !password) return {}
  try {
    const unsealed = await unsealSession(event, { password, name: LUKK_SESSION_COOKIE }, sealed)
    return (unsealed as { data?: TokenSession }).data ?? {}
  }
  catch {
    // Tampered, expired, or wrong-secret seal → treat as no session.
    return {}
  }
}

// RFC 6265bis §5.6: the browser silently drops a cookie whose name+value exceeds 4096 octets. The sealed
// __Host-lukk-session holds access + refresh + confirmation, so a backend embedding many claims via
// `Lukk::tokenClaimsUsing` can push it over — after which every request is anonymous and auth breaks
// intermittently, with no error surfaced. The iron seal inflates the JSON ~1.34× plus a ~280-byte
// envelope, so a ~2.6 KB plaintext session lands near the limit; warn while there's still headroom to trim.
const SESSION_DATA_BUDGET = 2600
function warnIfSessionTooLarge(session: { data: TokenSession }): void {
  if (JSON.stringify(session.data).length > SESSION_DATA_BUDGET) {
    console.warn(
      '[lukk] The sealed __Host-lukk-session cookie is nearing the 4096-octet browser limit (RFC 6265bis §5.6); '
      + 'above it the browser silently drops it and every request becomes anonymous. '
      + 'Trim your access-token claims (Lukk::tokenClaimsUsing) to shrink the sealed session.',
    )
  }
}

function isConfirmation(value: unknown): value is { confirmation_token: string } {
  return typeof value === 'object' && value !== null
    && typeof (value as { confirmation_token?: unknown }).confirmation_token === 'string'
}

function safeParse(text: string): unknown {
  try { return JSON.parse(text) }
  catch { return text }
}
