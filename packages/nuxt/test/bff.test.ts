import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __test } from './mocks/imports'

// Track read-write session opens so a test can assert the read-only path never mints a cookie,
// plus the cookie name the writer opens the session under (to verify the per-app namespace).
const h3state = vi.hoisted(() => ({ useSessionCalls: 0, lastSessionName: undefined as string | undefined, lastSessionConfig: undefined as { name?: string, cookie?: Record<string, unknown>, sessionHeader?: boolean } | undefined }))
vi.mock('h3', () => ({
  defineEventHandler: (fn: unknown) => fn,
  getRequestHeader: (event: { headers: Record<string, string> }, name: string) => event.headers[name],
  // A cookie is "present" unless the test opts out (`cookiePresent: false` → an anonymous request).
  getCookie: (event: { __session?: unknown, __cookiePresent?: boolean }) =>
    (event.__cookiePresent === false ? undefined : (event.__session ? 'sealed' : undefined)),
  unsealSession: async (event: { __session?: { data: unknown }, __sealTampered?: boolean, __sealNoData?: boolean }) => {
    if (event.__sealTampered) throw new Error('bad seal')
    if (event.__sealNoData) return {} // unsealed, but carries no `data` → defensive `?? {}`
    return event.__session ? { data: event.__session.data } : {}
  },
  readRawBody: async (event: { body?: string }) => event.body,
  getRequestIP: (event: { ip?: string }) => event.ip,
  setResponseStatus: (event: { status: number }, status: number) => { event.status = status },
  setResponseHeader: (event: { headers: Record<string, string>, __res?: Record<string, string> }, name: string, value: string) => {
    (event.__res ??= {})[name] = value
  },
  useSession: async (event: { __session: unknown }, config: { name?: string, cookie?: Record<string, unknown>, sessionHeader?: boolean }) => { h3state.useSessionCalls++; h3state.lastSessionName = config?.name; h3state.lastSessionConfig = config; return event.__session },
  deleteCookie: (event: { __deleted?: { name: string, options: unknown }[] }, name: string, options: unknown) => { (event.__deleted ??= []).push({ name, options }) },
}))

// eslint-disable-next-line import/first
import handler from '../src/runtime/server/bff'
// eslint-disable-next-line import/first
import { endSession, forgetEndedSessions, markSessionEnded, sessionEnded, useSharedEndedSessions } from '../src/runtime/server/ended-sessions'
// eslint-disable-next-line import/first
import { forgetRefreshJournal, refreshJournals } from '../src/runtime/server/refresh-journal'
// eslint-disable-next-line import/first
import { refreshOnce } from '../src/runtime/server/refresh'

interface TokenSession { access?: string, refresh?: string, confirmation?: string, sid?: string }

function makeSession(initial: TokenSession = {}, id = 'sid') {
  const s = {
    id,
    data: { ...initial } as TokenSession,
    update: vi.fn(async (d: TokenSession) => { Object.assign(s.data, d) }),
    clear: vi.fn(async () => { s.data = {} }),
  }
  return s
}

function makeEvent(o: { path: string, method?: string, body?: string, headers?: Record<string, string>, session: ReturnType<typeof makeSession>, cookiePresent?: boolean, sealTampered?: boolean, sealNoData?: boolean }) {
  const responseHeaders = new Map<string, unknown>()
  const res = {
    getHeader: (k: string) => responseHeaders.get(k),
    setHeader: (k: string, v: unknown) => { responseHeaders.set(k, v) },
    removeHeader: (k: string) => { responseHeaders.delete(k) },
  }
  return { path: o.path, method: o.method ?? 'GET', body: o.body, headers: o.headers ?? {}, ip: '203.0.113.7', __session: o.session, __cookiePresent: o.cookiePresent ?? true, __sealTampered: o.sealTampered ?? false, __sealNoData: o.sealNoData ?? false, status: 200, node: { res } }
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(body == null ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const run = (event: ReturnType<typeof makeEvent>) => (handler as unknown as (e: unknown) => Promise<unknown>)(event)
const mockFetch = () => globalThis as unknown as { fetch: ReturnType<typeof vi.fn> }
// A same-origin pair so non-GET requests pass the CSRF check.
const sameOrigin = { origin: 'https://app.example.com', host: 'app.example.com' }

beforeEach(() => {
  __test.runtimeConfig.lukk = { baseURL: 'https://lukk/auth', sessionPassword: 'p'.repeat(32) } as unknown as Record<string, unknown>
  ;(__test.runtimeConfig as Record<string, unknown>).public = { lukk: {} }
  h3state.useSessionCalls = 0
  h3state.lastSessionName = undefined
  h3state.lastSessionConfig = undefined
  forgetEndedSessions()
  // Sessions here share ids and tokens across tests; a rotation one test journalled must not answer another.
  for (const key of [...refreshJournals.keys()]) forgetRefreshJournal(key)
})
afterEach(() => { __test.reset(); vi.restoreAllMocks() })

describe('BFF proxy', () => {
  it('captures + strips tokens on login (no Bearer yet, content-type forwarded)', async () => {
    const session = makeSession()
    mockFetch().fetch = vi.fn().mockResolvedValue(jsonRes({ access_token: 'a', refresh_token: 'r', expires_in: 900 }))

    const event = makeEvent({ path: '/api/_lukk/login', method: 'POST', body: '{"email":"e"}', headers: { ...sameOrigin, 'content-type': 'application/json' }, session })
    const result = await run(event)

    expect(session.update).toHaveBeenCalledWith({ access: 'a', refresh: 'r', confirmation: undefined, sid: expect.any(String) })
    expect(result).toEqual({ ok: true, expires_in: 900 })
    // A logout noted before this sign-in was for the session it replaced — left, the next page would end this one.
    expect((event as { __deleted?: { name: string }[] }).__deleted?.map(d => d.name)).toEqual(['__Host-lukk-logout', '__Host-lukk-signed-out'])
    const init = mockFetch().fetch.mock.calls[0]![1]!
    expect(init.headers['Content-Type']).toBe('application/json')
    expect(init.headers.Authorization).toBeUndefined()
  })

  it('sends no X-Forwarded-For to lukk by default', async () => {
    // Unset, our socket address is all we know and it identifies this server, not the visitor —
    // asserting it would be a misleading identity, so we say nothing at all.
    const session = makeSession()
    mockFetch().fetch = vi.fn().mockResolvedValue(jsonRes({ ok: true }))
    await run(makeEvent({ path: '/api/_lukk/forgot-password', method: 'POST', headers: { ...sameOrigin, 'cf-connecting-ip': '198.51.100.23' }, session }))
    expect(mockFetch().fetch.mock.calls[0]![1]!.headers['X-Forwarded-For']).toBeUndefined()
  })

  it('forwards the visitor IP to lukk when a trusted clientIpHeader is configured', async () => {
    // lukk throttles forgot-password / login / two-factor-challenge on `$request->ip()`; without
    // this every visitor shares one bucket, so one user can lock out all the others.
    ;(__test.runtimeConfig.lukk as Record<string, unknown>).clientIpHeader = 'cf-connecting-ip'
    const session = makeSession()
    mockFetch().fetch = vi.fn().mockResolvedValue(jsonRes({ ok: true }))
    await run(makeEvent({ path: '/api/_lukk/forgot-password', method: 'POST', headers: { ...sameOrigin, 'x-forwarded-for': '1.2.3.4', 'cf-connecting-ip': '198.51.100.23' }, session }))
    expect(mockFetch().fetch.mock.calls[0]![1]!.headers['X-Forwarded-For']).toBe('198.51.100.23')
  })

  it('stays silent when the trusted header is configured but absent from the request', async () => {
    // An origin hit that bypassed the CDN, an internal caller, a health check. Guarding on CONFIG
    // rather than on "did we actually find a visitor" would send lukk our own socket address here —
    // the misleading rate-limit identity this path exists to avoid.
    ;(__test.runtimeConfig.lukk as Record<string, unknown>).clientIpHeader = 'cf-connecting-ip'
    const session = makeSession()
    mockFetch().fetch = vi.fn().mockResolvedValue(jsonRes({ ok: true }))
    await run(makeEvent({ path: '/api/_lukk/login', method: 'POST', headers: sameOrigin, session }))
    expect(mockFetch().fetch.mock.calls[0]![1]!.headers['X-Forwarded-For']).toBeUndefined()
  })

  it('keeps the session when a refresh is THROTTLED, and clears it only on a real rejection', async () => {
    // A 429 leaves the refresh token unconsumed and still valid. Treating it like a revocation turned
    // a transient throttle into an unrecoverable logout — and forwarding the real client IP makes
    // /refresh the highest-volume throttled call, so this is the path most likely to hit it.
    const throttled = makeSession({ access: 'old', refresh: 'rt' })
    mockFetch().fetch = vi.fn(async (url: string) =>
      String(url).endsWith('/refresh') ? jsonRes({ message: 'Too Many Requests' }, 429) : jsonRes({ message: 'unauth' }, 401))
    await run(makeEvent({ path: '/api/_lukk/data', session: throttled }))
    expect(throttled.clear).not.toHaveBeenCalled()
    expect(throttled.data.refresh).toBe('rt') // still there to retry with

    // A 401 from lukk means the token really is revoked/reused — that ends the session.
    const revoked = makeSession({ access: 'old', refresh: 'rt' })
    mockFetch().fetch = vi.fn().mockResolvedValue(jsonRes({ message: 'unauth' }, 401))
    await run(makeEvent({ path: '/api/_lukk/data', session: revoked }))
    expect(revoked.clear).toHaveBeenCalled()
  })

  it('never carries the previous session\'s refresh token into a sign-in that issued none', async () => {
    // Sealed under the new access token, the next refresh turned the browser back into the previous
    // account, and replayed a token lukk had already rotated — reported by reuse detection as theft.
    const session = makeSession({ access: 'previous', refresh: 'previous-refresh' })
    mockFetch().fetch = vi.fn().mockResolvedValue(jsonRes({ access_token: 'a', expires_in: 900 }))
    await run(makeEvent({ path: '/api/_lukk/login', method: 'POST', headers: sameOrigin, session }))
    expect(session.update).toHaveBeenCalledWith({ access: 'a', refresh: undefined, confirmation: undefined, sid: expect.any(String) })
  })

  it('seals the session into a __Host-, Secure, HttpOnly, SameSite=Strict cookie — and no header channel', async () => {
    // The NAME's `__Host-` prefix was pinned; its attributes were not, because the mock kept only the
    // name. Dropping `httpOnly`, relaxing `sameSite` to `lax`, forcing `secure: false`, or letting
    // `sessionHeader` default back on — an auth channel outside every one of these — all stayed green.
    const session = makeSession()
    mockFetch().fetch = vi.fn().mockResolvedValue(jsonRes({ access_token: 'a', refresh_token: 'r', expires_in: 900 }))

    await run(makeEvent({ path: '/api/_lukk/login', method: 'POST', headers: sameOrigin, session }))

    expect(h3state.lastSessionConfig).toMatchObject({
      name: '__Host-lukk-session',
      sessionHeader: false,
      cookie: { sameSite: 'strict', secure: true, httpOnly: true, path: '/' },
    })
  })

  it('gives every seal it writes a lifetime — 30 days unless configured', async () => {
    // Without one, iron seals with no expiry: a seal copied out of a browser unsealed forever, long
    // after the session it held had ended. iron stamps the expiry into the seal and checks it on every
    // unseal, so it is set where the seal is written.
    mockFetch().fetch = vi.fn(async () => jsonRes({ access_token: 'a', refresh_token: 'r', expires_in: 900 }))
    await run(makeEvent({ path: '/api/_lukk/login', method: 'POST', headers: sameOrigin, session: makeSession() }))
    expect(h3state.lastSessionConfig).toMatchObject({ seal: { ttl: 2592000 * 1000 } })

    ;(__test.runtimeConfig.lukk as Record<string, unknown>).sessionMaxAge = 3600
    await run(makeEvent({ path: '/api/_lukk/login', method: 'POST', headers: sameOrigin, session: makeSession() }))
    expect(h3state.lastSessionConfig).toMatchObject({ seal: { ttl: 3600 * 1000 } })
  })

  it('keeps the session cookie across a browser restart for the same lifetime as its seal', async () => {
    // With no Max-Age the cookie was a session cookie, dropped when the browser closed — so a BFF user was
    // signed out on every restart while a direct-mode user, holding lukk's persistent refresh cookie, was
    // not. Max-Age, not h3's `maxAge` (an Expires counted from the session's first creation): it restarts
    // on every write, as the seal's own lifetime does.
    mockFetch().fetch = vi.fn(async () => jsonRes({ access_token: 'a', refresh_token: 'r', expires_in: 900 }))
    await run(makeEvent({ path: '/api/_lukk/login', method: 'POST', headers: sameOrigin, session: makeSession() }))
    expect(h3state.lastSessionConfig?.cookie).toMatchObject({ maxAge: 2592000, httpOnly: true, sameSite: 'strict', path: '/' })
    expect((h3state.lastSessionConfig as { maxAge?: unknown }).maxAge).toBeUndefined()

    ;(__test.runtimeConfig.lukk as Record<string, unknown>).sessionMaxAge = 3600
    await run(makeEvent({ path: '/api/_lukk/login', method: 'POST', headers: sameOrigin, session: makeSession() }))
    expect(h3state.lastSessionConfig?.cookie).toMatchObject({ maxAge: 3600 })
  })

  it('deletes the session cookie outright when it clears the session, rather than leaving an empty one standing', async () => {
    // h3's `clear()` rewrites the cookie empty with the session's own options — with a Max-Age, that kept
    // an empty `__Host-` cookie for the whole lifetime instead of removing it.
    const session = makeSession({ access: 'A', refresh: 'rA' })
    mockFetch().fetch = vi.fn(async () => jsonRes(null, 204))
    const event = makeEvent({ path: '/api/_lukk/logout', method: 'POST', body: '{}', headers: sameOrigin, session })

    await run(event)

    expect(session.clear).toHaveBeenCalled()
    expect((event as unknown as { __deleted?: { name: string }[] }).__deleted?.map(d => d.name)).toContain('__Host-lukk-session')
  })

  it('writes the sealed session under the per-app namespaced cookie name', async () => {
    ;(__test.runtimeConfig.lukk as Record<string, unknown>).cookieNamespace = 'admin' // → __Host-lukk-admin-session
    const session = makeSession()
    mockFetch().fetch = vi.fn().mockResolvedValue(jsonRes({ access_token: 'a', refresh_token: 'r', expires_in: 900 }))
    await run(makeEvent({ path: '/api/_lukk/login', method: 'POST', headers: sameOrigin, session }))
    // The writer opens the session under the namespaced name, so a co-hosted app can't clobber it.
    expect(h3state.lastSessionName).toBe('__Host-lukk-admin-session')
  })

  it('attaches the session access + confirmation tokens, ignoring any browser-sent confirmation', async () => {
    const session = makeSession({ access: 'tok', confirmation: 'server-ct' })
    mockFetch().fetch = vi.fn().mockResolvedValue(jsonRes({ passkeys: [] }))
    const result = await run(makeEvent({ path: '/api/_lukk/passkeys?x=1', headers: { 'x-lukk-confirmation': 'browser-ct' }, session }))
    expect(result).toEqual({ passkeys: [] })
    const init = mockFetch().fetch.mock.calls[0]![1]!
    expect(init.headers.Authorization).toBe('Bearer tok')
    expect(init.headers['X-Lukk-Confirmation']).toBe('server-ct') // from the session, NOT the browser
  })

  it('refreshes server-side on 401, then retries', async () => {
    const session = makeSession({ access: 'old', refresh: 'rt' })
    mockFetch().fetch = vi.fn(async (url: string, init?: { headers?: Record<string, string> }) =>
      String(url).endsWith('/refresh')
        ? jsonRes({ access_token: 'new', refresh_token: 'rt2', expires_in: 900 })
        : (init?.headers?.Authorization === 'Bearer new' ? jsonRes({ passkeys: [] }) : jsonRes({ message: 'unauth' }, 401)))

    expect(await run(makeEvent({ path: '/api/_lukk/passkeys', session }))).toEqual({ passkeys: [] })
    expect(session.update).toHaveBeenCalledWith({ access: 'new', refresh: 'rt2' })
  })

  it.each(['/login', '/register', '/two-factor-challenge', '/passkeys/login'])('passes a 401 from %s straight through — no refresh, no retry', async (path) => {
    // A sign-in's 401 is its answer (a passkey whose user is gone), not an expired token. Refreshing
    // rotated the session being replaced and replayed a spent ceremony.
    const session = makeSession({ access: 'old', refresh: 'rt' })
    mockFetch().fetch = vi.fn().mockResolvedValue(jsonRes({ message: 'Unauthenticated.' }, 401))
    const event = makeEvent({ path: `/api/_lukk${path}`, method: 'POST', body: '{}', headers: sameOrigin, session })

    await run(event)

    expect(event.status).toBe(401)
    expect(mockFetch().fetch).toHaveBeenCalledOnce()
    expect(session.update).not.toHaveBeenCalled()
    expect(session.clear).not.toHaveBeenCalled()
  })

  it('does not keep a refresh token lukk just consumed when the rotation returned none', async () => {
    // Kept, the next refresh replayed it past the grace window: a false reuse, and a family revoke.
    const session = makeSession({ access: 'old', refresh: 'rt' })
    mockFetch().fetch = vi.fn(async (url: string, init?: { headers?: Record<string, string> }) =>
      String(url).endsWith('/refresh')
        ? jsonRes({ access_token: 'new', expires_in: 900 })
        : (init?.headers?.Authorization === 'Bearer new' ? jsonRes({ ok: true }) : jsonRes({ message: 'x' }, 401)))
    await run(makeEvent({ path: '/api/_lukk/data', session }))
    expect(session.update).toHaveBeenCalledWith({ access: 'new', refresh: undefined })
  })

  it('single-flights the server-side refresh across concurrent requests', async () => {
    const s1 = makeSession({ access: 'old', refresh: 'rt' }, 'shared')
    const s2 = makeSession({ access: 'old', refresh: 'rt' }, 'shared')
    let refreshCalls = 0
    mockFetch().fetch = vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
      if (String(url).endsWith('/refresh')) {
        refreshCalls++
        await new Promise(r => setTimeout(r, 10))
        return jsonRes({ access_token: 'new', refresh_token: 'rt2', expires_in: 900 })
      }
      return init?.headers?.Authorization === 'Bearer new' ? jsonRes({ ok: true }) : jsonRes({ message: 'x' }, 401)
    })

    await Promise.all([
      run(makeEvent({ path: '/api/_lukk/a', session: s1 })),
      run(makeEvent({ path: '/api/_lukk/b', session: s2 })),
    ])
    expect(refreshCalls).toBe(1) // one rotated refresh token, never replayed
  })

  it('refreshes when the session has no id', async () => {
    const session = makeSession({ access: 'old', refresh: 'rt' })
    ;(session as { id?: string }).id = undefined
    mockFetch().fetch = vi.fn(async (url: string, init?: { headers?: Record<string, string> }) =>
      String(url).endsWith('/refresh')
        ? jsonRes({ access_token: 'new', refresh_token: 'rt2', expires_in: 900 })
        : (init?.headers?.Authorization === 'Bearer new' ? jsonRes({ ok: true }) : jsonRes({ message: 'x' }, 401)))
    await run(makeEvent({ path: '/api/_lukk/x', session }))
    expect(session.update).toHaveBeenCalledWith({ access: 'new', refresh: 'rt2' })
  })

  it('clears the session when refresh fails', async () => {
    const session = makeSession({ access: 'old', refresh: 'rt' })
    mockFetch().fetch = vi.fn(async () => jsonRes({ message: 'gone' }, 401))
    const event = makeEvent({ path: '/api/_lukk/passkeys', session })
    await run(event)
    expect(session.clear).toHaveBeenCalledOnce()
    expect(event.status).toBe(401)
  })

  it('passes a 401 through when there is no refresh token (no refresh attempt)', async () => {
    const session = makeSession()
    mockFetch().fetch = vi.fn().mockResolvedValue(jsonRes({ message: 'unauth' }, 401))
    const event = makeEvent({ path: '/api/_lukk/passkeys', session })
    await run(event)
    expect(event.status).toBe(401)
    expect(mockFetch().fetch).toHaveBeenCalledOnce()
  })

  it('never opens (mints) a session for an anonymous request with no cookie', async () => {
    const session = makeSession()
    mockFetch().fetch = vi.fn().mockResolvedValue(jsonRes({ message: 'unauth' }, 401))
    const event = makeEvent({ path: '/api/_lukk/passkeys', session, cookiePresent: false })
    await run(event)
    expect(event.status).toBe(401)
    expect(session.update).not.toHaveBeenCalled()
    expect(session.clear).not.toHaveBeenCalled()
    // The read-only path never opens the read-write session → no empty-cookie mint.
    expect(h3state.useSessionCalls).toBe(0)
  })

  it('treats a tampered/expired seal as no session (no bearer, no mint)', async () => {
    const session = makeSession({ access: 'tok' })
    mockFetch().fetch = vi.fn().mockResolvedValue(jsonRes({ message: 'unauth' }, 401))
    const event = makeEvent({ path: '/api/_lukk/passkeys', session, sealTampered: true })
    await run(event)
    const init = mockFetch().fetch.mock.calls[0]![1]!
    expect(init.headers.Authorization).toBeUndefined() // unreadable seal → no bearer attached
    expect(h3state.useSessionCalls).toBe(0) // and no fresh cookie minted
  })

  it('tolerates a sealed session that unseals without data', async () => {
    const session = makeSession()
    mockFetch().fetch = vi.fn().mockResolvedValue(jsonRes({ message: 'x' }, 401))
    const event = makeEvent({ path: '/api/_lukk/x', session, sealNoData: true })
    await run(event)
    expect(event.status).toBe(401)
  })

  it('captures + strips a step-up confirmation token (kept server-side)', async () => {
    const session = makeSession({ access: 'tok' })
    mockFetch().fetch = vi.fn().mockResolvedValue(jsonRes({ confirmation_token: 'ct' }))
    const result = await run(makeEvent({ path: '/api/_lukk/confirm-password', method: 'POST', headers: sameOrigin, session }))
    expect(session.update).toHaveBeenCalledWith({ confirmation: 'ct' })
    expect(result).toEqual({ ok: true })
  })

  it('warns once when the sealed session nears the 4096-octet cookie limit', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const session = makeSession()
    // An access JWT bloated by large `tokenClaimsUsing` claims → the sealed cookie risks the 4096 limit.
    const bigAccess = 'a'.repeat(3000)
    mockFetch().fetch = vi.fn().mockResolvedValue(jsonRes({ access_token: bigAccess, refresh_token: 'r', expires_in: 900 }))
    await run(makeEvent({ path: '/api/_lukk/login', method: 'POST', headers: sameOrigin, session }))
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0]![0]).toContain('4096-octet')
  })

  it('does not warn for a normally-sized session', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const session = makeSession()
    mockFetch().fetch = vi.fn().mockResolvedValue(jsonRes({ access_token: 'a', refresh_token: 'r', expires_in: 900 }))
    await run(makeEvent({ path: '/api/_lukk/login', method: 'POST', headers: sameOrigin, session }))
    expect(warn).not.toHaveBeenCalled()
  })

  it('presents the sealed refresh token to lukk on logout, as JSON — whatever the browser sent', async () => {
    // lukk can then end the session even with an expired access token and a throttled refresh.
    const session = makeSession({ access: 'A', refresh: 'rA' })
    mockFetch().fetch = vi.fn(async () => jsonRes(null, 204))

    await run(makeEvent({ path: '/api/_lukk/logout', method: 'POST', body: 'ignored', headers: { ...sameOrigin, 'content-type': 'text/plain' }, session }))

    const init = mockFetch().fetch.mock.calls[0]![1] as { body: string, headers: Record<string, string> }
    expect(JSON.parse(init.body)).toEqual({ refresh_token: 'rA' })
    expect(init.headers['Content-Type']).toBe('application/json')
    expect(init.headers.Authorization).toBe('Bearer A')
  })

  it('presents the ROTATED refresh token when the logout had to renew first, and an empty body with none', async () => {
    const session = makeSession({ access: 'A-expired', refresh: 'rA' })
    mockFetch().fetch = vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
      if (String(url).endsWith('/refresh')) return jsonRes({ access_token: 'A2', refresh_token: 'rA2', expires_in: 900 })
      return init?.headers?.Authorization === 'Bearer A2' ? jsonRes(null, 204) : jsonRes({ message: 'Unauthenticated.' }, 401)
    })

    await run(makeEvent({ path: '/api/_lukk/logout', method: 'POST', headers: sameOrigin, session }))
    const logouts = mockFetch().fetch.mock.calls.filter(([url]) => String(url).endsWith('/logout'))
    expect(logouts.map(([, init]) => JSON.parse((init as { body: string }).body))).toEqual([{ refresh_token: 'rA' }, { refresh_token: 'rA2' }])

    const anonymous = makeSession({ access: 'A' })
    mockFetch().fetch = vi.fn(async () => jsonRes(null, 204))
    await run(makeEvent({ path: '/api/_lukk/logout', method: 'POST', headers: sameOrigin, session: anonymous }))
    expect(JSON.parse((mockFetch().fetch.mock.calls[0]![1] as { body: string }).body)).toEqual({})
  })

  it('clears the session on logout — and the browser\'s logout note with it', async () => {
    const session = makeSession({ access: 'tok' })
    mockFetch().fetch = vi.fn().mockResolvedValue(jsonRes(null, 204))
    const event = makeEvent({ path: '/api/_lukk/logout', method: 'POST', headers: sameOrigin, session })
    await run(event)
    expect(session.clear).toHaveBeenCalledOnce()
    expect((event as { __deleted?: { name: string }[] }).__deleted?.map(d => d.name)).toEqual(['__Host-lukk-session', '__Host-lukk-logout', '__Host-lukk-signed-out'])

    // Named like the session cookie: relaxed and namespaced with it.
    Object.assign(__test.runtimeConfig.lukk, { cookieSecure: false, cookieNamespace: 'admin' })
    const dev = makeEvent({ path: '/api/_lukk/logout', method: 'POST', headers: { origin: 'http://app.example.com', host: 'app.example.com' }, session: makeSession({ access: 'tok' }) })
    await run(dev)
    expect((dev as { __deleted?: { name: string, options: unknown }[] }).__deleted).toEqual([
      // The session cookie too, now that it carries a Max-Age that `clear()` would leave standing.
      { name: 'lukk-admin-session', options: { sameSite: 'strict', secure: false, httpOnly: true, path: '/', maxAge: 2592000 } },
      { name: 'lukk-admin-logout', options: { path: '/', secure: false, sameSite: 'strict' } },
      { name: 'lukk-admin-signed-out', options: { path: '/', secure: false, sameSite: 'strict' } },
    ])
  })

  it.each([
    ['a throttled logout (429)', () => jsonRes({ message: 'Too Many Attempts.' }, 429)],
    ['an upstream outage (503)', () => jsonRes({ message: 'Service Unavailable' }, 503)],
  ])('keeps the session when lukk did not end it: %s', async (_, answer) => {
    // Clearing left the session live on lukk with nothing pointing at it, and the visitor thinking they
    // had logged out. The status reaches the client, which can retry.
    const session = makeSession({ access: 'A', refresh: 'rA', sid: 'session-A' } as TokenSession)
    mockFetch().fetch = vi.fn(async () => answer())
    const event = makeEvent({ path: '/api/_lukk/logout', method: 'POST', body: '{}', headers: sameOrigin, session })

    await run(event)

    expect(event.status).toBe(answer().status)
    expect(session.clear).not.toHaveBeenCalled()
    // The browser's note stays too: the logout isn't done.
    expect((event as { __deleted?: unknown[] }).__deleted).toBeUndefined()
    // Nor recorded as ended: its refreshes must keep working until the retry succeeds.
    mockFetch().fetch = vi.fn(async () => jsonRes({ access_token: 'A2', refresh_token: 'rA2', expires_in: 900 }))
    const refresh = makeEvent({ path: '/api/_lukk/refresh', method: 'POST', body: '{}', headers: sameOrigin, session: makeSession({ access: 'A', refresh: 'rA', sid: 'session-A' } as TokenSession) })
    await run(refresh)
    expect(refresh.status).toBe(200)
  })

  it('keeps the session when the logout 401s only because its refresh was throttled', async () => {
    const session = makeSession({ access: 'A-expired', refresh: 'rA' })
    mockFetch().fetch = vi.fn(async (url: string) => (String(url).endsWith('/refresh') ? jsonRes({ message: 'Too Many Attempts.' }, 429) : jsonRes({ message: 'Unauthenticated.' }, 401)))

    await run(makeEvent({ path: '/api/_lukk/logout', method: 'POST', body: '{}', headers: sameOrigin, session }))

    expect(session.clear).not.toHaveBeenCalled()
  })

  it('clears a session lukk says is gone, even when nothing could renew it', async () => {
    const session = makeSession({ access: 'A-dead' })
    mockFetch().fetch = vi.fn(async () => jsonRes({ message: 'Unauthenticated.' }, 401))

    await run(makeEvent({ path: '/api/_lukk/logout', method: 'POST', body: '{}', headers: sameOrigin, session }))

    expect(session.clear).toHaveBeenCalledOnce()
  })

  it('defaults to "/" when the proxy path is bare', async () => {
    const session = makeSession({ access: 'tok' })
    mockFetch().fetch = vi.fn().mockResolvedValue(jsonRes({ ok: true }))
    await run(makeEvent({ path: '/api/_lukk', session }))
    expect(mockFetch().fetch.mock.calls[0]![0]).toBe('https://lukk/auth/')
  })

  it('passes a non-JSON body through untouched', async () => {
    const session = makeSession({ access: 'tok' })
    mockFetch().fetch = vi.fn().mockResolvedValue(new Response('plain text', { status: 200 }))
    expect(await run(makeEvent({ path: '/api/_lukk/x', session }))).toBe('plain text')
  })

  // --- CSRF ---
  it('rejects a cross-origin state-changing request (CSRF)', async () => {
    const session = makeSession({ access: 'tok' })
    mockFetch().fetch = vi.fn()
    const event = makeEvent({ path: '/api/_lukk/sessions', method: 'DELETE', headers: { origin: 'https://evil.com', host: 'app.example.com' }, session })
    await run(event)
    expect(event.status).toBe(403)
    expect(mockFetch().fetch).not.toHaveBeenCalled()
  })

  it('allows a same-origin state-changing request', async () => {
    const session = makeSession({ access: 'tok' })
    mockFetch().fetch = vi.fn().mockResolvedValue(jsonRes(null, 204))
    await run(makeEvent({ path: '/api/_lukk/sessions', method: 'DELETE', headers: sameOrigin, session }))
    expect(mockFetch().fetch).toHaveBeenCalledOnce()
  })

  // --- path containment (SSRF / traversal) ---
  it('rejects a path that escapes the lukk base (traversal), with the generic invalid-path 400', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const session = makeSession({ access: 'tok' })
    mockFetch().fetch = vi.fn()
    const event = makeEvent({ path: '/api/_lukk/../../admin', session })
    // A genuine escape must stay generic — only the config fault gets the descriptive message.
    expect(await run(event)).toEqual({ message: 'Invalid path.' })
    expect(event.status).toBe(400)
    expect(mockFetch().fetch).not.toHaveBeenCalled()
  })

  it('rejects an encoded-traversal path', async () => {
    const session = makeSession({ access: 'tok' })
    mockFetch().fetch = vi.fn()
    const event = makeEvent({ path: '/api/_lukk/%2e%2e/%2e%2e/admin', session })
    await run(event)
    expect(event.status).toBe(400)
    expect(mockFetch().fetch).not.toHaveBeenCalled()
  })

  it('rejects a state-changing request with a malformed Origin', async () => {
    const session = makeSession({ access: 'tok' })
    mockFetch().fetch = vi.fn()
    const event = makeEvent({ path: '/api/_lukk/sessions', method: 'DELETE', headers: { origin: 'garbage', host: 'app.example.com' }, session })
    await run(event)
    expect(event.status).toBe(403)
    expect(mockFetch().fetch).not.toHaveBeenCalled()
  })

  it('reports a misconfigured baseURL as a config fault, NOT as "Invalid path."', async () => {
    // Regression (the production incident): a baked-in "undefined/auth" answered `Invalid path.`,
    // which sent operators hunting a client/backend route mismatch that didn't exist. The path was
    // fine — the baseURL wasn't. The offending value is logged server-side, never returned.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    __test.runtimeConfig.lukk = { baseURL: 'undefined/auth', sessionPassword: 'p'.repeat(32) } as unknown as Record<string, unknown>
    mockFetch().fetch = vi.fn()

    const event = makeEvent({ path: '/api/_lukk/forgot-password', session: makeSession() })
    const body = await run(event) as { message: string }

    expect(event.status).toBe(500) // a deployment fault, so it must page someone — not a 4xx
    expect(body.message).toContain('Proxy target could not be resolved')
    expect(body.message).not.toBe('Invalid path.')
    expect(String(error.mock.calls[0]![0])).toContain('undefined/auth')
    expect(mockFetch().fetch).not.toHaveBeenCalled()
  })

  it('fetches with redirect:manual so an upstream 3xx is never followed', async () => {
    const session = makeSession({ access: 'a' })
    mockFetch().fetch = vi.fn().mockResolvedValue(jsonRes({ ok: true }))
    await run(makeEvent({ path: '/api/_lukk/x', method: 'POST', headers: { ...sameOrigin }, session }))
    expect(mockFetch().fetch.mock.calls[0]![1]!.redirect).toBe('manual')
  })

  it('rejects an opaque upstream redirect (creds not re-emitted to a redirect host)', async () => {
    const session = makeSession({ access: 'a', refresh: 'r', confirmation: 'c' })
    mockFetch().fetch = vi.fn().mockResolvedValue({ type: 'opaqueredirect', status: 0 })
    const event = makeEvent({ path: '/api/_lukk/x', method: 'POST', headers: { ...sameOrigin }, session })
    expect(await run(event)).toEqual({ message: 'Upstream redirect rejected.' })
    expect(event.status).toBe(502)
  })

  it('cancels the body of a redirect it refuses, so the connection is released', async () => {
    const cancel = vi.fn()
    mockFetch().fetch = vi.fn().mockResolvedValue(new Response(new ReadableStream({ cancel }), { status: 302, headers: { location: 'https://evil.example/x' } }))
    const event = makeEvent({ path: '/api/_lukk/x', method: 'POST', headers: { ...sameOrigin }, session: makeSession({ access: 'a' }) })

    expect(await run(event)).toEqual({ message: 'Upstream redirect rejected.' })
    expect(cancel).toHaveBeenCalled()
  })

  it('rejects a 3xx upstream response without chasing the Location', async () => {
    const session = makeSession({ access: 'a', refresh: 'r' })
    mockFetch().fetch = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location: 'https://evil.example/x' } }))
    const event = makeEvent({ path: '/api/_lukk/x', method: 'POST', headers: { ...sameOrigin }, session })
    expect(await run(event)).toEqual({ message: 'Upstream redirect rejected.' })
    expect(event.status).toBe(502)
  })
})

describe('a session replaced or ended while a refresh for it was out', () => {
  // The browser keeps the LAST Set-Cookie. A refresh already out for the old session, answering after
  // a login or logout, put that session back — the previous account under the new one, or a cleared
  // cookie re-created.
  function deferredFetch() {
    let answer!: (r: Response) => void
    const pending = new Promise<Response>((resolve) => { answer = resolve })
    return { pending, answer }
  }
  const post = (path: string, session: ReturnType<typeof makeSession>) =>
    makeEvent({ path: `/api/_lukk${path}`, method: 'POST', body: '{}', headers: sameOrigin, session })

  it.each([
    ['a login', '/login', () => jsonRes({ access_token: 'B', refresh_token: 'rB', expires_in: 900 })],
    ['a logout', '/logout', () => jsonRes(null, 204)],
  ])('does not write back a /refresh that answers after %s', async (_, path, answer) => {
    const refreshing = makeSession({ access: 'A', refresh: 'rA', sid: 'session-A' } as TokenSession)
    const signingIn = makeSession({ access: 'A', refresh: 'rA', sid: 'session-A' } as TokenSession)
    const upstream = deferredFetch()
    mockFetch().fetch = vi.fn(async (url: string) => (String(url).endsWith('/refresh') ? upstream.pending : answer()))

    const refreshEvent = post('/refresh', refreshing)
    const pendingRefresh = run(refreshEvent)
    await new Promise(resolve => setTimeout(resolve, 0))
    await run(post(path, signingIn))
    upstream.answer(jsonRes({ access_token: 'A2', refresh_token: 'rA2', expires_in: 900 }))

    expect(await pendingRefresh).toEqual({ message: 'The session was replaced.' })
    expect(refreshEvent.status).toBe(409)
    expect(refreshing.update).not.toHaveBeenCalled()
    expect(refreshing.clear).not.toHaveBeenCalled()
    // The rotation it dropped is revoked, so its consumed refresh token can't later look like theft.
    expect(mockFetch().fetch).toHaveBeenCalledWith('https://lukk/auth/logout', expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer A2' }) }))
  })

  it('does not clear the newer session over a definitive reject that answers late', async () => {
    const refreshing = makeSession({ access: 'A', refresh: 'rA', sid: 'session-A' } as TokenSession)
    const upstream = deferredFetch()
    mockFetch().fetch = vi.fn(async (url: string) => (String(url).endsWith('/refresh') ? upstream.pending : jsonRes({ access_token: 'B', expires_in: 900 })))

    const pendingRefresh = run(post('/refresh', refreshing))
    await new Promise(resolve => setTimeout(resolve, 0))
    await run(post('/login', makeSession({ access: 'A', refresh: 'rA', sid: 'session-A' } as TokenSession)))
    upstream.answer(jsonRes({ message: 'revoked' }, 401))
    await pendingRefresh

    expect(refreshing.clear).not.toHaveBeenCalled()
  })

  it('does not even rotate a session that already ended', async () => {
    mockFetch().fetch = vi.fn(async () => jsonRes(null, 204))
    await run(post('/logout', makeSession({ access: 'A', refresh: 'rA', sid: 'session-A' } as TokenSession)))
    mockFetch().fetch = vi.fn()

    const late = makeSession({ access: 'A', refresh: 'rA', sid: 'session-A' } as TokenSession)
    const event = post('/refresh', late)
    await run(event)

    expect(event.status).toBe(409)
    expect(mockFetch().fetch).not.toHaveBeenCalled()
  })

  it('passes a proxied 401 straight back for an ended session, without rotating or writing', async () => {
    mockFetch().fetch = vi.fn(async () => jsonRes(null, 204))
    await run(post('/logout', makeSession({ access: 'A', refresh: 'rA', sid: 'session-A' } as TokenSession)))
    mockFetch().fetch = vi.fn(async () => jsonRes({ message: 'Unauthenticated.' }, 401))

    const late = makeSession({ access: 'A', refresh: 'rA', sid: 'session-A' } as TokenSession)
    const event = makeEvent({ path: '/api/_lukk/passkeys', session: late })
    await run(event)

    expect(event.status).toBe(401)
    expect(mockFetch().fetch).toHaveBeenCalledOnce()
    expect(late.update).not.toHaveBeenCalled()
    expect(late.clear).not.toHaveBeenCalled()
  })

  it('does not write back a proxied request\'s refresh that answers after a logout', async () => {
    const refreshing = makeSession({ access: 'A', refresh: 'rA', sid: 'session-A' } as TokenSession)
    const upstream = deferredFetch()
    mockFetch().fetch = vi.fn(async (url: string) => {
      if (String(url).endsWith('/refresh')) return upstream.pending
      if (String(url).endsWith('/logout')) return jsonRes(null, 204)
      return jsonRes({ message: 'Unauthenticated.' }, 401)
    })

    const event = makeEvent({ path: '/api/_lukk/passkeys', session: refreshing })
    const pending = run(event)
    await new Promise(resolve => setTimeout(resolve, 0))
    await run(post('/logout', makeSession({ access: 'A', refresh: 'rA', sid: 'session-A' } as TokenSession)))
    upstream.answer(jsonRes({ access_token: 'A2', refresh_token: 'rA2', expires_in: 900 }))
    await pending

    expect(event.status).toBe(401)
    expect(refreshing.update).not.toHaveBeenCalled()
    // Nor retried with the replaced session's fresh token: the original call, the refresh, the logout —
    // then, in the background, a logout with the tokens that refresh minted so they can't linger.
    const calls = mockFetch().fetch.mock.calls.map(([url, init]) => [String(url).replace('https://lukk/auth', ''), (init as { headers?: Record<string, string> })?.headers?.Authorization])
    expect(calls).toEqual([['/passkeys', 'Bearer A'], ['/refresh', undefined], ['/logout', 'Bearer A'], ['/logout', 'Bearer A2']])
  })

  it('does not clear the newer session when a proxied request\'s refresh is rejected after a login', async () => {
    const refreshing = makeSession({ access: 'A', refresh: 'rA', sid: 'session-A' } as TokenSession)
    const upstream = deferredFetch()
    mockFetch().fetch = vi.fn(async (url: string) => {
      if (String(url).endsWith('/refresh')) return upstream.pending
      if (String(url).endsWith('/login')) return jsonRes({ access_token: 'B', expires_in: 900 })
      return jsonRes({ message: 'Unauthenticated.' }, 401)
    })

    const pending = run(makeEvent({ path: '/api/_lukk/passkeys', session: refreshing }))
    await new Promise(resolve => setTimeout(resolve, 0))
    await run(post('/login', makeSession({ access: 'A', refresh: 'rA', sid: 'session-A' } as TokenSession)))
    upstream.answer(jsonRes({ message: 'revoked' }, 401))
    await pending

    expect(refreshing.clear).not.toHaveBeenCalled()
  })

  it('does not write back a refresh whose RETRIED call was still out when a logout landed', async () => {
    // The re-seal used to happen before the retried call, so its cookie left with a response that
    // could take as long as that call — long after the session had ended.
    const refreshing = makeSession({ access: 'A', refresh: 'rA', sid: 'session-A' } as TokenSession)
    const retried = deferredFetch()
    let calls = 0
    mockFetch().fetch = vi.fn(async (url: string) => {
      if (String(url).endsWith('/refresh')) return jsonRes({ access_token: 'A2', refresh_token: 'rA2', expires_in: 900 })
      if (String(url).endsWith('/logout')) return jsonRes(null, 204)
      return ++calls === 1 ? jsonRes({ message: 'Unauthenticated.' }, 401) : retried.pending
    })

    const pending = run(makeEvent({ path: '/api/_lukk/passkeys', session: refreshing }))
    await new Promise(resolve => setTimeout(resolve, 0))
    await run(post('/logout', makeSession({ access: 'A', refresh: 'rA', sid: 'session-A' } as TokenSession)))
    retried.answer(jsonRes({ passkeys: [] }))
    await pending

    expect(refreshing.update).not.toHaveBeenCalled()
    // Its rotation is dropped, so it is revoked rather than left to trip reuse detection later.
    expect(mockFetch().fetch).toHaveBeenCalledWith('https://lukk/auth/logout', expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer A2' }) }))
  })

  it('still seals the rotated session when the retried call can\'t reach lukk, so it is not stranded on a spent token', async () => {
    const session = makeSession({ access: 'A', refresh: 'rA', sid: 'session-A' } as TokenSession)
    let calls = 0
    mockFetch().fetch = vi.fn(async (url: string) => {
      if (String(url).endsWith('/refresh')) return jsonRes({ access_token: 'A2', refresh_token: 'rA2', expires_in: 900 })
      if (++calls === 1) return jsonRes({ message: 'Unauthenticated.' }, 401)
      throw new TypeError('fetch failed')
    })
    const event = makeEvent({ path: '/api/_lukk/passkeys', session })

    expect(await run(event)).toEqual({ message: 'lukk could not be reached.' })
    expect(event.status).toBe(502)
    expect(session.update).toHaveBeenCalledWith({ access: 'A2', refresh: 'rA2' })
  })

  it('answers 502 when lukk can\'t be reached at all, instead of escaping as a 500', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const session = makeSession({ access: 'A', refresh: 'rA' })
    mockFetch().fetch = vi.fn(async () => { throw new TypeError('fetch failed') })
    const event = makeEvent({ path: '/api/_lukk/session/claim', method: 'POST', body: '{}', headers: sameOrigin, session })

    expect(await run(event)).toEqual({ message: 'lukk could not be reached.' })
    expect(event.status).toBe(502)
    expect(session.clear).not.toHaveBeenCalled()
    // Diagnosable: the cause is reported (once per target and cause, like the app-API proxy).
    expect(error).toHaveBeenCalled()
  })

  it('answers 502 when lukk sends its headers and then stalls the body, rather than hanging', async () => {
    // The deadline used to end with the headers, so `res.text()` waited on a stalled body for as long as
    // the runtime's socket timeout allowed — holding the request, and the session's refresh behind it.
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    mockFetch().fetch = vi.fn(async (_url: string, init: RequestInit) => new Response(new ReadableStream({
      start(controller) { init.signal?.addEventListener('abort', () => controller.error(init.signal!.reason)) },
    }), { status: 200 }))
    const event = makeEvent({ path: '/api/_lukk/two-factor/recovery-codes', session: makeSession({ access: 'A' }) })

    const result = run(event)
    await vi.advanceTimersByTimeAsync(15_000)

    await expect(result).resolves.toEqual({ message: 'lukk could not be reached.' })
    expect(event.status).toBe(502)
    vi.useRealTimers()
  })

  it('does not write back a step-up confirmation that answers after a sign-in — h3 re-seals the whole session', async () => {
    const confirming = makeSession({ access: 'A', refresh: 'rA', sid: 'session-A' } as TokenSession)
    const upstream = deferredFetch()
    mockFetch().fetch = vi.fn(async (url: string) => (String(url).endsWith('/confirm-password') ? upstream.pending : jsonRes({ access_token: 'B', expires_in: 900 })))

    const event = post('/confirm-password', confirming)
    const pending = run(event)
    await new Promise(resolve => setTimeout(resolve, 0))
    await run(post('/login', makeSession({ access: 'A', refresh: 'rA', sid: 'session-A' } as TokenSession)))
    upstream.answer(jsonRes({ confirmation_token: 'ct' }))

    expect(await pending).toEqual({ message: 'The session was replaced.' })
    expect(event.status).toBe(409)
    expect(confirming.update).not.toHaveBeenCalled()
  })

  it('does not record a logout that arrived with a cookie that would not unseal', async () => {
    // Anyone can send a garbage cookie; recording each one let a flood evict the entries that matter.
    mockFetch().fetch = vi.fn(async () => jsonRes(null, 204))
    const forged = makeSession({}, 'h3-forged')

    await run(makeEvent({ path: '/api/_lukk/logout', method: 'POST', headers: sameOrigin, session: forged, sealTampered: true }))

    const later = makeSession({ access: 'X', refresh: 'rX' }, 'h3-forged')
    mockFetch().fetch = vi.fn(async () => jsonRes({ access_token: 'X2', expires_in: 900 }))
    const event = post('/refresh', later)
    await run(event)
    expect(event.status).toBe(200)
  })

  it('withholds a re-sealed cookie when the session ends while it is being sealed', async () => {
    // Sealing is async (iron), so a logout can land after the retry's own ended-check and before the
    // response leaves. The last check before it does must still catch it, and revoke what was sealed.
    const refreshing = makeSession({ access: 'A', refresh: 'rA', sid: 'session-A' } as TokenSession)
    let calls = 0
    mockFetch().fetch = vi.fn(async (url: string) => {
      if (String(url).endsWith('/refresh')) return jsonRes({ access_token: 'A2', refresh_token: 'rA2', expires_in: 900 })
      if (String(url).endsWith('/logout')) return jsonRes(null, 204)
      return ++calls === 1 ? jsonRes({ message: 'Unauthenticated.' }, 401) : jsonRes({ passkeys: [] })
    })
    const event = makeEvent({ path: '/api/_lukk/passkeys', session: refreshing })
    refreshing.update.mockImplementation(async (d: TokenSession) => {
      Object.assign(refreshing.data, d)
      event.node.res.setHeader('set-cookie', ['__Host-lukk-session=RESEALED', 'other=1'])
      await run(post('/logout', makeSession({ access: 'A', refresh: 'rA', sid: 'session-A' } as TokenSession)))
    })

    expect(await run(event)).toEqual({ passkeys: [] })
    expect(event.node.res.getHeader('set-cookie')).toEqual(['other=1'])
    expect(mockFetch().fetch).toHaveBeenCalledWith('https://lukk/auth/logout', expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer A2' }) }))
  })

  it('withholds a re-sealed cookie when the session ends while the retried response body is still being read', async () => {
    const refreshing = makeSession({ access: 'A', refresh: 'rA', sid: 'session-A' } as TokenSession)
    let finishBody!: () => void
    const slowBody = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"passkeys":'))
        finishBody = () => { controller.enqueue(new TextEncoder().encode('[]}')); controller.close() }
      },
    })
    let calls = 0
    mockFetch().fetch = vi.fn(async (url: string) => {
      if (String(url).endsWith('/refresh')) return jsonRes({ access_token: 'A2', refresh_token: 'rA2', expires_in: 900 })
      if (String(url).endsWith('/logout')) return jsonRes(null, 204)
      return ++calls === 1 ? jsonRes({ message: 'Unauthenticated.' }, 401) : new Response(slowBody, { status: 200 })
    })
    const event = makeEvent({ path: '/api/_lukk/passkeys', session: refreshing })
    refreshing.update.mockImplementation(async (d: TokenSession) => {
      Object.assign(refreshing.data, d)
      event.node.res.setHeader('set-cookie', ['__Host-lukk-session=RESEALED', 'other=1'])
    })

    const pending = run(event)
    await new Promise(resolve => setTimeout(resolve, 0))
    await run(post('/logout', makeSession({ access: 'A', refresh: 'rA', sid: 'session-A' } as TokenSession)))
    finishBody()

    expect(await pending).toEqual({ passkeys: [] })
    // The body is read inside the upstream deadline, so the seal is decided once it is in: the logout is
    // seen there, and the ended session is never re-sealed onto this response at all.
    expect(refreshing.update).not.toHaveBeenCalled()
    expect(event.node.res.getHeader('set-cookie')).toBeUndefined()
    expect(mockFetch().fetch).toHaveBeenCalledWith('https://lukk/auth/logout', expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer A2' }) }))
  })

  it('withholds a /refresh re-seal when the session ends while that write is being made', async () => {
    const refreshing = makeSession({ access: 'A', refresh: 'rA', sid: 'session-A' } as TokenSession)
    mockFetch().fetch = vi.fn(async () => jsonRes({ access_token: 'A2', refresh_token: 'rA2', expires_in: 900 }))
    const event = post('/refresh', refreshing)
    refreshing.update.mockImplementation(async (d: TokenSession) => {
      Object.assign(refreshing.data, d)
      event.node.res.setHeader('set-cookie', '__Host-lukk-session=RESEALED')
      markSessionEnded('session-A') // a sign-in elsewhere lands during the write
    })

    expect(await run(event)).toEqual({ message: 'The session was replaced.' })
    expect(event.status).toBe(409)
    expect(event.node.res.getHeader('set-cookie')).toBeUndefined()
    expect(mockFetch().fetch).toHaveBeenCalledWith('https://lukk/auth/logout', expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer A2' }) }))
  })

  it('still renews an ended session on logout, so lukk revokes it — without writing it back', async () => {
    // After a lost sign-in response the browser keeps the replaced session. Skipping the refresh on its
    // expired token meant no authenticated /logout ever reached lukk, and the family stayed alive.
    await endSession('session-A', { replaced: true })
    const ending = makeSession({ access: 'A-expired', refresh: 'rA', sid: 'session-A' } as TokenSession)
    const bearers: (string | undefined)[] = []
    mockFetch().fetch = vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
      if (String(url).endsWith('/refresh')) return jsonRes({ access_token: 'A2', refresh_token: 'rA2', expires_in: 900 })
      bearers.push(init?.headers?.Authorization)
      return init?.headers?.Authorization === 'Bearer A2' ? jsonRes(null, 204) : jsonRes({ message: 'Unauthenticated.' }, 401)
    })

    await run(post('/logout', ending))

    expect(bearers).toEqual(['Bearer A-expired', 'Bearer A2'])
    expect(ending.update).not.toHaveBeenCalled()
    // Already replaced: the browser may hold the newer session's cookie, which a clear would wipe.
    expect(ending.clear).not.toHaveBeenCalled()
  })

  it('clears the cookie again for a logout resent after its first response was lost', async () => {
    // The first logout ended the session (not a sign-in replacing it), so the browser holds no newer
    // cookie — only the dead one the lost response would have cleared.
    await endSession('session-A')
    const resent = makeSession({ access: 'A', refresh: 'rA', sid: 'session-A' } as TokenSession)
    mockFetch().fetch = vi.fn(async () => jsonRes(null, 204))

    await run(post('/logout', resent))

    expect(resent.clear).toHaveBeenCalledOnce()
  })

  it('does not clear the cookie of a newer sign-in when a slow logout from the replaced session lands', async () => {
    // Another tab signed in while this tab's logout was out; the clear landed last and signed that
    // newer session out, leaving it alive on lukk with nothing pointing at it.
    const loggingOut = makeSession({ access: 'A', refresh: 'rA', sid: 'session-A' } as TokenSession)
    const upstream = deferredFetch()
    mockFetch().fetch = vi.fn(async (url: string) => (String(url).endsWith('/logout') ? upstream.pending : jsonRes({ access_token: 'B', refresh_token: 'rB', expires_in: 900 })))

    const event = post('/logout', loggingOut)
    const pending = run(event)
    await new Promise(resolve => setTimeout(resolve, 0))
    await run(post('/login', makeSession({ access: 'A', refresh: 'rA', sid: 'session-A' } as TokenSession)))
    upstream.answer(jsonRes(null, 204))
    await pending

    expect(loggingOut.clear).not.toHaveBeenCalled()
    // Nor a logout note beside that newer session's cookie: it would be that session's.
    expect((event as { __deleted?: unknown[] }).__deleted).toBeUndefined()
  })

  it('ends the session a sign-in replaces on lukk too, not only in the browser', async () => {
    // Its cookie is overwritten, so nothing reaches it again — but it stayed live on lukk until it expired,
    // and when the sign-in's response never reached the browser the browser kept using it all along.
    const replaced = makeSession({ access: 'A', refresh: 'rA', sid: 'session-A' } as TokenSession)
    mockFetch().fetch = vi.fn(async (url: string) => (String(url).endsWith('/logout') ? jsonRes(null, 204) : jsonRes({ access_token: 'B', refresh_token: 'rB', expires_in: 900 })))

    await run(post('/login', replaced))

    const revocations = mockFetch().fetch.mock.calls.filter(([url]) => String(url).endsWith('/logout'))
    expect(revocations).toHaveLength(1)
    const init = revocations[0]![1] as { headers: Record<string, string>, body: string }
    expect(init.headers.Authorization).toBe('Bearer A')
    expect(JSON.parse(init.body)).toEqual({ refresh_token: 'rA' })
  })

  it('does not answer a sign-in before the shared store has recorded the session it replaced', async () => {
    // Another instance must already see the old session as ended by the time the browser holds the new
    // cookie — or a late refresh served there writes it back.
    let recorded!: () => void
    const marked = new Promise<void>((resolve) => { recorded = resolve })
    useSharedEndedSessions({ mark: () => marked, has: async () => false })
    mockFetch().fetch = vi.fn(async (url: string) => (String(url).endsWith('/logout') ? jsonRes(null, 204) : jsonRes({ access_token: 'B', refresh_token: 'rB', expires_in: 900 })))

    let answered = false
    const signingIn = run(post('/login', makeSession({ access: 'A', refresh: 'rA', sid: 'session-A' } as TokenSession))).then(() => { answered = true })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(answered).toBe(false)

    recorded()
    await signingIn
    expect(answered).toBe(true)
    useSharedEndedSessions(undefined)
  })

  it('revokes nothing when the sign-in replaced no session', async () => {
    mockFetch().fetch = vi.fn(async () => jsonRes({ access_token: 'B', refresh_token: 'rB', expires_in: 900 }))

    await run(makeEvent({ path: '/api/_lukk/login', method: 'POST', body: '{}', headers: sameOrigin, session: makeSession({}), cookiePresent: false }))

    expect(mockFetch().fetch.mock.calls.filter(([url]) => String(url).endsWith('/logout'))).toHaveLength(0)
  })

  it('gives every sign-in a new session id, and leaves a session that was never signed in unmarked', async () => {
    mockFetch().fetch = vi.fn(async () => jsonRes({ access_token: 'B', expires_in: 900 }))
    const anonymous = makeSession({}, 'h3-anon')

    await run(makeEvent({ path: '/api/_lukk/login', method: 'POST', body: '{}', headers: sameOrigin, session: anonymous, cookiePresent: false }))
    const first = (anonymous.data as { sid?: string }).sid

    // A later refresh for the anonymous h3 id is not blocked — nothing it could overwrite.
    const other = makeSession({ access: 'X', refresh: 'rX' }, 'h3-anon')
    mockFetch().fetch = vi.fn(async () => jsonRes({ access_token: 'X2', expires_in: 900 }))
    const event = post('/refresh', other)
    await run(event)
    expect(event.status).toBe(200)

    mockFetch().fetch = vi.fn(async () => jsonRes({ access_token: 'C', expires_in: 900 }))
    await run(post('/login', anonymous))
    expect(first).toEqual(expect.any(String))
    expect((anonymous.data as { sid?: string }).sid).not.toBe(first)
  })
})

describe('the /refresh subpath is served, not proxied', () => {
  it('rotates the sealed token and returns the tokenless shape', async () => {
    // The browser holds an opaque cookie, not a refresh token, so its body is empty. Proxying it
    // asked lukk to rotate nothing (401), and the generic 401 branch then rotated the SEALED token
    // and retried the same empty body — a rotation burned per attempt, still a 401. `restore()` on
    // app load is exactly this call, so in BFF mode it could never succeed.
    const session = makeSession({ access: 'old', refresh: 'rt-seed' })
    const fetchMock = vi.fn().mockResolvedValue(jsonRes({ access_token: 'new-at', refresh_token: 'rt-1', expires_in: 900 }))
    mockFetch().fetch = fetchMock

    const event = makeEvent({ path: '/api/_lukk/refresh', method: 'POST', headers: { ...sameOrigin }, body: '{}', session })
    const body = await run(event) as { ok: boolean, expires_in: number }

    // Exactly ONE upstream call, and it carried the SEALED token — not the browser's empty body.
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(String(fetchMock.mock.calls[0]![1]!.body)).toContain('rt-seed')

    expect(body).toEqual({ ok: true, expires_in: 900 })
    expect(JSON.stringify(body)).not.toContain('rt-1')
    expect(session.data).toMatchObject({ access: 'new-at', refresh: 'rt-1' })
  })

  it('401s an anonymous caller without minting a session cookie', async () => {
    const session = makeSession({})
    mockFetch().fetch = vi.fn()

    const event = makeEvent({ path: '/api/_lukk/refresh', method: 'POST', headers: { ...sameOrigin }, body: '{}', session, cookiePresent: false })
    await run(event)

    expect(event.status).toBe(401)
    expect(mockFetch().fetch).not.toHaveBeenCalled()
    expect(h3state.useSessionCalls).toBe(0) // never opened read-write → no empty cookie minted
  })

  it('keeps the session on a throttled refresh but clears it on a definitive reject', async () => {
    const throttled = makeSession({ refresh: 'rt' })
    mockFetch().fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 429 }))
    const ev1 = makeEvent({ path: '/api/_lukk/refresh', method: 'POST', headers: { ...sameOrigin }, body: '{}', session: throttled })
    await run(ev1)
    expect(ev1.status).toBe(503)
    expect(throttled.data.refresh).toBe('rt') // a 429 must not turn into a logout

    const rejected = makeSession({ refresh: 'rt' })
    mockFetch().fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 401 }))
    const ev2 = makeEvent({ path: '/api/_lukk/refresh', method: 'POST', headers: { ...sameOrigin }, body: '{}', session: rejected })
    await run(ev2)
    expect(ev2.status).toBe(401)
    expect(rejected.data).toEqual({})
    // Only a wait that ran out says when to come back; a throttle's own timing is lukk's to give.
    expect((ev1 as { __res?: Record<string, string> }).__res?.['retry-after']).toBeUndefined()
  })

  it('answers a refresh lukk is slow to rotate with a retryable 503 and Retry-After, keeping the session', async () => {
    // The rotation itself is never aborted, but the browser is not held on it: it is told to come back,
    // and its retry joins the call still out rather than replaying the token lukk may already have rotated.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const slow = makeSession({ refresh: 'rt', sid: `slow-${Math.random()}` } as TokenSession)
    mockFetch().fetch = vi.fn(() => new Promise(() => {}))
    const event = makeEvent({ path: '/api/_lukk/refresh', method: 'POST', headers: { ...sameOrigin }, body: '{}', session: slow })

    const result = run(event)
    await vi.advanceTimersByTimeAsync(15_000)

    expect(await result).toEqual({ message: 'Unauthenticated.' })
    expect(event.status).toBe(503)
    expect((event as { __res?: Record<string, string> }).__res?.['retry-after']).toBe('5')
    expect(slow.clear).not.toHaveBeenCalled()
    vi.useRealTimers()
  })
})

describe('a rotation that lands after the request waiting on it gave up', () => {
  // lukk rotated, but the request that asked was answered 503 at 15 s. The browser still holds the
  // consumed token; its next request — whenever the user next acts — must adopt the rotation and seal it,
  // never replay the token past lukk's grace window and have the family revoked.
  const late = () => vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).endsWith('/refresh')) {
      return new Promise<Response>(resolve => setTimeout(() => resolve(jsonRes({ access_token: 'late-at', refresh_token: 'late-rt', expires_in: 900 })), 20_000))
    }
    const auth = new Headers(init?.headers).get('authorization')
    return auth === 'Bearer late-at' ? jsonRes({ id: 1 }) : jsonRes({ message: 'Unauthenticated.' }, 401)
  })
  const refreshCalls = () => mockFetch().fetch.mock.calls.filter(([url]) => String(url).endsWith('/refresh')).length

  afterEach(() => vi.useRealTimers())

  it('is adopted and sealed by the next /refresh still carrying the old cookie', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    mockFetch().fetch = late()
    const sid = `bff-late-${Math.random()}`
    const first = makeEvent({ path: '/api/_lukk/refresh', method: 'POST', headers: { ...sameOrigin }, body: '{}', session: makeSession({ refresh: 'old-rt', sid } as TokenSession) })
    const answered = run(first)
    await vi.advanceTimersByTimeAsync(15_000)
    await answered
    expect(first.status).toBe(503)
    await vi.advanceTimersByTimeAsync(60_000) // lands at 20 s; the user comes back much later

    const again = makeSession({ refresh: 'old-rt', sid } as TokenSession)
    const body = await run(makeEvent({ path: '/api/_lukk/refresh', method: 'POST', headers: { ...sameOrigin }, body: '{}', session: again }))

    expect(body).toEqual({ ok: true, expires_in: 900 })
    expect(again.update).toHaveBeenCalledWith({ access: 'late-at', refresh: 'late-rt' })
    expect(refreshCalls()).toBe(1)
  })

  it('is adopted and sealed by the next proxied call\'s 401 retry', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    mockFetch().fetch = late()
    const sid = `bff-retry-${Math.random()}`
    const answered = run(makeEvent({ path: '/api/_lukk/user', session: makeSession({ access: 'old', refresh: 'old-rt', sid } as TokenSession) }))
    await vi.advanceTimersByTimeAsync(15_000)
    await answered
    await vi.advanceTimersByTimeAsync(60_000)

    const again = makeSession({ access: 'old', refresh: 'old-rt', sid } as TokenSession)
    const event = makeEvent({ path: '/api/_lukk/user', session: again })
    expect(await run(event)).toEqual({ id: 1 })

    expect(again.update).toHaveBeenCalledWith({ access: 'late-at', refresh: 'late-rt' })
    expect(again.clear).not.toHaveBeenCalled()
    expect(refreshCalls()).toBe(1)
  })

  it('seals the NEWEST pair when the session rotated the adopted one while the retried call was out', async () => {
    // A rotates t0 → t1; straggler S (t0) adopts t1 at 0.5 s, and its retried call is slow. Another tab's
    // restore rotates t1 → t2 meanwhile. Sealed as adopted, S's cookie landed over t2's with t1 — spent —
    // and t1's next refresh, after its link expired, revoked the family.
    let finishRetry!: () => void
    mockFetch().fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const body = String(init?.body ?? '')
      if (String(url).endsWith('/refresh')) {
        return body.includes('"t0"') ? jsonRes({ access_token: 'a1', refresh_token: 't1', expires_in: 900 }) : jsonRes({ access_token: 'a2', refresh_token: 't2', expires_in: 900 })
      }
      const bearer = new Headers(init?.headers).get('authorization')
      if (bearer === 'Bearer a1') return new Promise<Response>((resolve) => { finishRetry = () => resolve(jsonRes({ id: 1 })) })
      return bearer === 'Bearer a2' ? jsonRes({ id: 1 }) : jsonRes({ message: 'Unauthenticated.' }, 401)
    })
    const sid = `bff-newest-${Math.random()}`
    await refreshOnce({ id: 'h3', data: { refresh: 't0', sid } }, 'https://lukk/auth') // A, received

    const straggler = makeSession({ access: 'old', refresh: 't0', sid } as TokenSession)
    const pending = run(makeEvent({ path: '/api/_lukk/user', session: straggler }))
    await new Promise(resolve => setTimeout(resolve, 0))
    await refreshOnce({ id: 'h3', data: { refresh: 't1', sid } }, 'https://lukk/auth') // the other tab
    finishRetry()

    expect(await pending).toEqual({ id: 1 })
    expect(straggler.update).toHaveBeenLastCalledWith({ access: 'a2', refresh: 't2' })
  })

  /**
   * A straggler's retried call held open (it honours the upstream deadline's abort, as real fetch does) while
   * the session rotates past the pair it adopted: t1 → t2 … t17 → t18, eighteen links in all, so the journal
   * — capped at REFRESH_JOURNAL_MAX_LINKS — has pruned the t0 and t1 links. Within the 15 s the auth proxy
   * waits, the links themselves never expire; overflow is the only way `currentPair` can answer stale here.
   */
  async function straggleWhileOverflowing(path: string, method: string, answer: unknown) {
    let finishRetry!: () => void
    mockFetch().fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/refresh')) {
        const n = Number(String(init?.body).match(/"t(\d+)"/)![1]) + 1
        return jsonRes({ access_token: `a${n}`, refresh_token: `t${n}`, expires_in: 900 })
      }
      if (new Headers(init?.headers).get('authorization') !== 'Bearer a1') return jsonRes({ message: 'Unauthenticated.' }, 401)
      return new Promise<Response>((resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))
        finishRetry = () => resolve(jsonRes(answer))
      })
    })
    const sid = `bff-overflow-${Math.random()}`
    await refreshOnce({ id: 'h3', data: { refresh: 't0', sid } }, 'https://lukk/auth') // t0 → t1, received

    const straggler = makeSession({ access: 'old', refresh: 't0', sid } as TokenSession)
    const event = makeEvent({ path, method, body: '{"password":"p"}', headers: { ...sameOrigin, 'content-type': 'application/json' }, session: straggler })
    const pending = run(event)
    await new Promise(resolve => setTimeout(resolve, 0)) // adopted t1; its retried call is out
    for (let n = 1; n <= 17; n++) await refreshOnce({ id: 'h3', data: { refresh: `t${n}`, sid } }, 'https://lukk/auth')
    expect(refreshJournals.get(sid)!.has('t1')).toBe(false)
    finishRetry()
    return { event, straggler, result: await pending }
  }

  it('seals nothing when the session moved past the adopted pair while the retried call was out — a backstop', async () => {
    // Sealing t1 over the browser's t18 replayed a spent token on its next refresh; the browser keeps t18.
    const { straggler, result } = await straggleWhileOverflowing('/api/_lukk/user', 'GET', { id: 1 })

    expect(result).toEqual({ id: 1 })
    expect(straggler.update).not.toHaveBeenCalled()
  })

  it('does not record a step-up onto a pair gone stale — 409 asks the user to confirm again, and no cookie', async () => {
    // The confirmation capture re-seals the WHOLE session — here, the arriving tokens with a spent refresh
    // token, over the browser's newer cookie. Nothing retries a 409 on a step-up: the user confirms again.
    const { event, straggler, result } = await straggleWhileOverflowing('/api/_lukk/confirm-password', 'POST', { confirmation_token: 'c1' })

    expect(result).toEqual({ message: 'Your session was renewed meanwhile. Please confirm again.' })
    expect(event.status).toBe(409)
    expect(straggler.update).not.toHaveBeenCalled()
  })

  it('/refresh seals the NEWEST pair when the session rotated its own meanwhile', async () => {
    // A shared-store check between the rotation and the seal is real I/O: another request can rotate the
    // pair just produced while it is out, and sealing it then put a spent token over the newer cookie.
    const sid = `refresh-newest-${Math.random()}`
    mockFetch().fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const n = Number(String(init?.body).match(/"t(\d+)"/)![1]) + 1
      return jsonRes({ access_token: `a${n}`, refresh_token: `t${n}`, expires_in: 900 })
    })
    let asked = 0
    useSharedEndedSessions({ mark: async () => {}, has: async () => {
      if (++asked === 2) await refreshOnce({ id: 'h3', data: { refresh: 't1', sid } }, 'https://lukk/auth')
      return false
    } })
    try {
      const s = makeSession({ refresh: 't0', sid } as TokenSession)
      // Its own lifetime is known only for the pair this request rotated; a newer one's is left out.
      expect(await run(makeEvent({ path: '/api/_lukk/refresh', method: 'POST', headers: { ...sameOrigin }, body: '{}', session: s }))).toEqual({ ok: true })
      expect(s.update).toHaveBeenCalledWith({ access: 'a2', refresh: 't2' })
    }
    finally { useSharedEndedSessions(undefined) }
  })

  it('/refresh seals nothing, and answers 409, when the session moved past its pair during those checks', async () => {
    // A backstop: here the journal overflows while the check is out, so the pair just produced is no
    // longer linked and is not the session's head.
    const sid = `refresh-stale-${Math.random()}`
    // Once t0 → t1 has landed, t1 … t17 rotate while the post-refresh check is out (the store answers
    // only when they are done).
    let overflowing: Promise<void> | undefined
    mockFetch().fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const n = Number(String(init?.body).match(/"t(\d+)"/)![1]) + 1
      if (n === 1) {
        overflowing = new Promise(resolve => setTimeout(resolve, 0)).then(async () => {
          for (let m = 1; m <= 17; m++) await refreshOnce({ id: 'h3', data: { refresh: `t${m}`, sid } }, 'https://lukk/auth')
        })
      }
      return jsonRes({ access_token: `a${n}`, refresh_token: `t${n}`, expires_in: 900 })
    })
    useSharedEndedSessions({ mark: async () => {}, has: async () => {
      await overflowing
      return false
    } })
    try {
      const s = makeSession({ refresh: 't0', sid } as TokenSession)
      const event = makeEvent({ path: '/api/_lukk/refresh', method: 'POST', headers: { ...sameOrigin }, body: '{}', session: s })
      expect(await run(event)).toEqual({ message: 'The session was replaced.' })
      expect(event.status).toBe(409)
      expect(s.update).not.toHaveBeenCalled()
    }
    finally { useSharedEndedSessions(undefined) }
  })

  it('records a step-up onto the NEWEST pair when the session rotated the request\'s own meanwhile', async () => {
    // Not a 401 retry: the request's access token was valid. But the confirmation capture re-seals the whole
    // session as it arrived — and another request rotated its refresh token while the step-up was out.
    let answer!: () => void
    mockFetch().fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/refresh')) return jsonRes({ access_token: 'a2', refresh_token: 't2', expires_in: 900 })
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer a1')
      return new Promise<Response>((resolve) => { answer = () => resolve(jsonRes({ confirmation_token: 'c1' })) })
    })
    const sid = `confirm-newest-${Math.random()}`
    const s = makeSession({ access: 'a1', refresh: 't1', sid } as TokenSession)
    const pending = run(makeEvent({ path: '/api/_lukk/confirm-password', method: 'POST', body: '{"password":"p"}', headers: { ...sameOrigin, 'content-type': 'application/json' }, session: s }))
    await new Promise(resolve => setTimeout(resolve, 0))
    await refreshOnce({ id: 'h3', data: { refresh: 't1', sid } }, 'https://lukk/auth') // another request
    answer()

    expect(await pending).toEqual({ ok: true })
    expect(s.update).toHaveBeenCalledWith({ access: 'a2', refresh: 't2', confirmation: 'c1' })
  })

  it('answers 409 to a step-up on a pair the session moved past, even without a retry', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      mockFetch().fetch = vi.fn(async (url: string) => (String(url).endsWith('/refresh')
        ? jsonRes({ access_token: 'a2', refresh_token: 't2', expires_in: 900 })
        : jsonRes({ confirmation_token: 'c1' })))
      const sid = `confirm-stale-${Math.random()}`
      const { currentPair } = await import('../src/runtime/server/refresh')
      currentPair(sid, (await refreshOnce({ id: 'h3', data: { refresh: 't1', sid } }, 'https://lukk/auth')).pair!) // delivered elsewhere
      await vi.advanceTimersByTimeAsync(31_000) // its link is gone; the session's head is t2

      const s = makeSession({ access: 'a1', refresh: 't1', sid } as TokenSession) // an old tab's cookie
      const event = makeEvent({ path: '/api/_lukk/confirm-password', method: 'POST', body: '{"password":"p"}', headers: { ...sameOrigin, 'content-type': 'application/json' }, session: s })
      expect(await run(event)).toEqual({ message: 'Your session was renewed meanwhile. Please confirm again.' })
      expect(event.status).toBe(409)
      expect(s.update).not.toHaveBeenCalled()
    }
    finally { vi.useRealTimers() }
  })

  it('a rotation a request DID receive is adopted by a straggler\'s 401 retry within the window', async () => {
    // A page's burst: one request renewed the session and carried the new cookie home; another, already out
    // with the old one, comes back seconds later. It is handed that same rotation — never a replay.
    mockFetch().fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/refresh')) return jsonRes({ access_token: 'new-at', refresh_token: 'new-rt', expires_in: 900 })
      return new Headers(init?.headers).get('authorization') === 'Bearer new-at' ? jsonRes({ id: 1 }) : jsonRes({ message: 'Unauthenticated.' }, 401)
    })
    const sid = `bff-received-${Math.random()}`
    expect(await run(makeEvent({ path: '/api/_lukk/user', session: makeSession({ access: 'old', refresh: 'old-rt', sid } as TokenSession) }))).toEqual({ id: 1 })

    const straggler = makeSession({ access: 'old', refresh: 'old-rt', sid } as TokenSession)
    expect(await run(makeEvent({ path: '/api/_lukk/user', session: straggler }))).toEqual({ id: 1 })

    expect(straggler.update).toHaveBeenCalledWith({ access: 'new-at', refresh: 'new-rt' })
    expect(refreshCalls()).toBe(1)
  })
})

describe('cache directives', () => {
  it('marks every auth response uncacheable, replacing the upstream header it drops', async () => {
    // lukk stamps no-store on credential responses; this handler returns a body and drops upstream
    // headers, so authenticated GETs (the passkey inventory, the recovery-code count) were reaching
    // shared caches with no directives and no Vary — heuristic freshness keyed on path alone.
    const session = makeSession({ access: 'a' })
    mockFetch().fetch = vi.fn().mockResolvedValue(jsonRes({ passkeys: [] }))

    const event = makeEvent({ path: '/api/_lukk/passkeys', method: 'GET', headers: { ...sameOrigin }, session })
    await run(event)

    expect(event.__res?.['cache-control']).toBe('private, no-store')
    expect(event.__res?.vary).toBe('cookie')
  })
})

describe('an anonymous logout', () => {
  it('opens no session and clears no cookie — it has none to clear', async () => {
    // `hasCookie` guards this: without it an unauthenticated `POST /logout` calls `useSession`, which
    // MINTS a sealed cookie so it can immediately expire one — handing a brand-new empty session to a
    // browser that had none, on an unauthenticated route. Nothing entered that branch before.
    h3state.useSessionCalls = 0
    mockFetch().fetch = vi.fn().mockResolvedValue(jsonRes({}))

    const event = makeEvent({ path: '/api/_lukk/logout', method: 'POST', headers: { ...sameOrigin } })
    await run(event)

    expect(h3state.useSessionCalls).toBe(0)
    expect((event as { __deleted?: { name: string }[] }).__deleted?.map(d => d.name) ?? []).toEqual([])
  })
})

describe('credential redaction fails closed', () => {
  it('strips refresh/confirmation tokens from a body that misses the capture gate', async () => {
    // The captures are allow-list gated (`isTokenPair` needs a STRING access_token), so a body that
    // almost matches used to skip the strip entirely and ship a rotating refresh token to the
    // browser — the one thing BFF mode exists to prevent. Capture on a match; redact regardless.
    const session = makeSession({ access: 'a' })
    // `access_token: null` misses isTokenPair (it needs a STRING), and there is no string
    // confirmation_token, so neither capture fires — this is the pass-through path.
    mockFetch().fetch = vi.fn().mockResolvedValue(
      jsonRes({ access_token: null, refresh_token: 'rt-leak', keep: 'me' }),
    )

    const body = await run(makeEvent({ path: '/api/_lukk/x', method: 'POST', headers: { ...sameOrigin }, session }))

    expect(JSON.stringify(body)).not.toContain('rt-leak')
    // `access_token` goes too, whatever its shape: the removal must not depend on the body being what the
    // capture gate expected — that is the whole point of a deny-list here.
    expect(body).toEqual({ keep: 'me' })

    // A non-string confirmation_token misses its capture gate the same way, and is still removed.
    mockFetch().fetch = vi.fn().mockResolvedValue(jsonRes({ confirmation_token: 12345, keep: 'me' }))
    const second = await run(makeEvent({ path: '/api/_lukk/y', method: 'POST', headers: { ...sameOrigin }, session }))

    expect(second).toEqual({ keep: 'me' })
  })

  it('reaches into arrays and nested objects, which the docblock promised and the code did not', async () => {
    // "A removal must not depend on the shape being what we expected" — but an array returned early and
    // a nested object was never looked at. A rebound response wrapping its payload (`{ data: {...} }`,
    // the Laravel API-Resource envelope lukk-core already unwraps for `user`), or any list of sessions,
    // carried a rotating refresh token straight through to the browser.
    const session = makeSession({ access: 'a' })
    mockFetch().fetch = vi.fn().mockResolvedValue(jsonRes({
      data: { keep: 'me', refresh_token: 'rt-nested' },
      sessions: [{ id: 1, access_token: 'at-in-array' }],
    }))

    const body = await run(makeEvent({ path: '/api/_lukk/x', method: 'POST', headers: { ...sameOrigin }, session }))

    expect(JSON.stringify(body)).not.toContain('rt-nested')
    expect(JSON.stringify(body)).not.toContain('at-in-array')
    expect(body).toEqual({ data: { keep: 'me' }, sessions: [{ id: 1 }] })
  })

  it('passes a credential-free body through untouched, including arrays and scalars', async () => {
    const session = makeSession({ access: 'a' })

    for (const payload of [{ passkeys: [] }, [1, 2, 3], 'plain text']) {
      mockFetch().fetch = vi.fn().mockResolvedValue(
        typeof payload === 'string' ? new Response(payload, { status: 200 }) : jsonRes(payload),
      )
      const body = await run(makeEvent({ path: '/api/_lukk/x', method: 'POST', headers: { ...sameOrigin }, session }))
      expect(body).toEqual(payload)
    }
  })
})

describe('dev over plain http', () => {
  it('does not 403 a login when the session cookie is not Secure', async () => {
    // The end-to-end version of the CSRF scheme check. `nuxi dev` over http serves the app at
    // http://localhost:3000 and sets a non-Secure cookie; inferring the scheme from the socket
    // instead answered "https" here (a plain Node socket has no `encrypted` property at all) and
    // rejected every non-GET — login, refresh, logout, confirmation.
    __test.runtimeConfig.lukk = {
      baseURL: 'https://lukk/auth',
      sessionPassword: 'p'.repeat(32),
      cookieSecure: false,
    } as unknown as Record<string, unknown>

    const session = makeSession({})
    mockFetch().fetch = vi.fn().mockResolvedValue(jsonRes({ access_token: 'at', refresh_token: 'rt', expires_in: 900 }))

    const event = makeEvent({
      path: '/api/_lukk/login',
      method: 'POST',
      headers: { origin: 'http://localhost:3000', host: 'localhost:3000' },
      body: '{}',
      session,
    })
    const body = await run(event)

    expect(event.status).not.toBe(403)
    expect(body).toEqual({ ok: true, expires_in: 900 })
  })
})

describe('what the auth proxy sends, and answers', () => {
  const big = 'a'.repeat(3000)

  it('forwards the browser\'s own body on a non-logout request, and reads none for GET or HEAD', async () => {
    // Only a logout swaps the body for the sealed refresh token; anything else presented that token
    // to whichever lukk route was asked for.
    mockFetch().fetch = vi.fn(async () => jsonRes({ ok: true }))
    await run(makeEvent({ path: '/api/_lukk/forgot-password', method: 'POST', body: '{"email":"e"}', headers: { ...sameOrigin, 'content-type': 'application/json' }, session: makeSession({ refresh: 'rA' }) }))
    expect(mockFetch().fetch.mock.calls[0]![1]!.body).toBe('{"email":"e"}')

    for (const method of ['GET', 'HEAD']) {
      mockFetch().fetch = vi.fn(async () => jsonRes({ ok: true }))
      await run(makeEvent({ path: '/api/_lukk/user', method, body: 'should-not-be-read', session: makeSession({ access: 'A' }) }))
      expect(mockFetch().fetch.mock.calls[0]![1]!.body, method).toBeUndefined()
    }
  })

  it('asks for JSON, names itself in Via, and adds no header it has no value for', async () => {
    mockFetch().fetch = vi.fn(async () => jsonRes({ ok: true }))
    await run(makeEvent({ path: '/api/_lukk/user', session: makeSession({ access: 'A' }) }))

    const headers = mockFetch().fetch.mock.calls[0]![1]!.headers as Record<string, string>
    expect(headers.Accept).toBe('application/json')
    expect(headers.Via).toMatch(/lukk-nuxt/)
    expect(Object.keys(headers)).not.toContain('Content-Type')
    expect(Object.keys(headers)).not.toContain('X-Lukk-Confirmation')
  })

  it.each(['same-site', 'cross-site'])('refuses a %s GET that is not a navigation', async (site) => {
    // GETs skipped the cross-site check. A same-site sibling could then fire credentialed no-cors GETs —
    // an `<img>` at `/api/_lukk/account/export` — that this proxy answered with the sealed session and
    // confirmation token, spending the user's step-up throttle. No page needs a cross-site subresource
    // GET from the auth proxy.
    const fetchMock = vi.fn(async () => jsonRes({}))
    mockFetch().fetch = fetchMock
    const event = makeEvent({ path: '/api/_lukk/account/export', headers: { 'sec-fetch-site': site, 'sec-fetch-mode': 'no-cors' }, session: makeSession({ access: 'A' }) })

    expect(await run(event)).toEqual({ message: 'Cross-origin request rejected.' })
    expect(event.status).toBe(403)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('still lets a top-level navigation through, such as a link clicked in an email', async () => {
    const fetchMock = vi.fn(async () => jsonRes({}))
    mockFetch().fetch = fetchMock

    await run(makeEvent({ path: '/api/_lukk/user', headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' }, session: makeSession({ access: 'A' }) }))

    expect(fetchMock).toHaveBeenCalled()
  })

  it.each(['iframe', 'frame', 'embed', 'object'])('refuses a cross-site navigation with destination %s — only a top-level one is a link the user followed', async (dest) => {
    // `Sec-Fetch-Mode: navigate` is also what a NESTED navigation sends: another site framing the auth
    // proxy rides the session cookie just as a subresource does, and nothing about it is the visitor's click.
    const fetchMock = vi.fn(async () => jsonRes({}))
    mockFetch().fetch = fetchMock
    const event = makeEvent({ path: '/api/_lukk/account/export', headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': dest }, session: makeSession({ access: 'A' }) })

    expect(await run(event)).toEqual({ message: 'Cross-origin request rejected.' })
    expect(event.status).toBe(403)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each(['GET', 'PUT', 'DELETE'])('answers a %s to /refresh with 405 and `Allow: POST`, never a rotation', async (method) => {
    // A rotation is a state change (RFC 9110 §9.2.1): a GET to it is one a prefetcher, a crawler or a
    // same-origin `<img>` can trigger, and rotating there spends the token on a response nobody reads.
    const session = makeSession({ access: 'A', refresh: 'rA' })
    const fetchMock = vi.fn(async () => jsonRes({ access_token: 'A2', refresh_token: 'rA2', expires_in: 900 }))
    mockFetch().fetch = fetchMock
    const event = makeEvent({ path: '/api/_lukk/refresh', method, headers: sameOrigin, body: '{}', session })

    expect(await run(event)).toEqual({ message: 'Method not allowed.' })
    expect(event.status).toBe(405)
    expect((event as { __res?: Record<string, string> }).__res?.allow).toBe('POST')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(session.update).not.toHaveBeenCalled()
  })

  it('still serves its own app\'s GETs', async () => {
    const fetchMock = vi.fn(async () => jsonRes({}))
    mockFetch().fetch = fetchMock

    await run(makeEvent({ path: '/api/_lukk/user', headers: { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' }, session: makeSession({ access: 'A' }) }))

    expect(fetchMock).toHaveBeenCalled()
  })

  it('tells a cross-origin caller why it was refused', async () => {
    const event = makeEvent({ path: '/api/_lukk/sessions', method: 'DELETE', headers: { origin: 'https://evil.com', host: 'app.example.com' }, session: makeSession({ access: 'A' }) })
    expect(await run(event)).toEqual({ message: 'Cross-origin request rejected.' })
  })

  it('names the setting at fault when the base cannot be resolved', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    __test.runtimeConfig.lukk = { baseURL: `undefined/auth-${Math.random()}`, sessionPassword: 'p'.repeat(32) } as unknown as Record<string, unknown>
    mockFetch().fetch = vi.fn()

    await run(makeEvent({ path: '/api/_lukk/user', session: makeSession({ access: 'A' }) }))

    expect(mockFetch().fetch).not.toHaveBeenCalled()
    expect(String(error.mock.calls[0]![0])).toContain('lukk `baseURL`')
  })

  it('answers "Unauthenticated." on /refresh with nothing to rotate, or a token lukk rejected', async () => {
    const none = makeEvent({ path: '/api/_lukk/refresh', method: 'POST', headers: sameOrigin, session: makeSession({ access: 'A' }) })
    expect(await run(none)).toEqual({ message: 'Unauthenticated.' })

    mockFetch().fetch = vi.fn(async () => jsonRes({ message: 'Unauthenticated.' }, 401))
    const rejected = makeEvent({ path: '/api/_lukk/refresh', method: 'POST', headers: sameOrigin, session: makeSession({ refresh: 'rA', sid: 'R1' } as TokenSession) })
    expect(await run(rejected)).toEqual({ message: 'Unauthenticated.' })
  })

  it.each([
    ['a /refresh', '/api/_lukk/refresh', 'POST', () => jsonRes({ access_token: big, refresh_token: 'r2', expires_in: 900 })],
    ['a 401 renewed mid-request', '/api/_lukk/user', 'GET', (url: string, auth?: string) =>
      String(url).endsWith('/refresh') ? jsonRes({ access_token: big, refresh_token: 'r2', expires_in: 900 }) : (auth === `Bearer ${big}` ? jsonRes({ ok: true }) : jsonRes({}, 401))],
    ['a step-up confirmation', '/api/_lukk/confirm-password', 'POST', () => jsonRes({ confirmation_token: big })],
  ])('warns when %s re-seals a session near the cookie limit', async (_, path, method, answer) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockFetch().fetch = vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => (answer as (u: string, a?: string) => Response)(url, init?.headers?.Authorization))

    await run(makeEvent({ path, method, headers: sameOrigin, session: makeSession({ access: 'A', refresh: 'rA', sid: `W-${path}` } as TokenSession) }))

    expect(String(warn.mock.calls[0]?.[0])).toContain('4096-octet')
  })

  it.each([[300, 502], [399, 502], [400, 400]])('treats an upstream %i as %i — only the 3xx range is a redirect', async (status, expected) => {
    mockFetch().fetch = vi.fn(async () => jsonRes({ message: 'x' }, status))
    const event = makeEvent({ path: '/api/_lukk/user', session: makeSession({ access: 'A' }) })
    await run(event)
    expect(event.status).toBe(expected)
  })

  it('ends the replaced session on sign-in even when it held only a refresh token', async () => {
    mockFetch().fetch = vi.fn(async () => jsonRes({ access_token: 'a', refresh_token: 'r', expires_in: 900 }))
    await run(makeEvent({ path: '/api/_lukk/login', method: 'POST', headers: sameOrigin, session: makeSession({ refresh: 'r-old', sid: 'OLD' } as TokenSession) }))
    expect(await sessionEnded('OLD')).toBe(true)
  })

  it('clears the cookie on a logout lukk answers 403, and records a session that held only an access token', async () => {
    mockFetch().fetch = vi.fn(async () => jsonRes({ message: 'Forbidden' }, 403))
    const forbidden = makeSession({ access: 'A', sid: 'F1' } as TokenSession)
    await run(makeEvent({ path: '/api/_lukk/logout', method: 'POST', headers: sameOrigin, session: forbidden }))
    expect(forbidden.clear).toHaveBeenCalledOnce()
    expect(await sessionEnded('F1')).toBe(true)
  })

  it('clears a logout whose renewal lukk refused outright, for a session an earlier logout ended', async () => {
    // A definitive refusal is not "still refreshable": only a throttle or an outage is.
    await endSession('L1')
    mockFetch().fetch = vi.fn(async () => jsonRes({ message: 'Unauthenticated.' }, 401))
    const session = makeSession({ access: 'A-expired', refresh: 'rA', sid: 'L1' } as TokenSession)

    await run(makeEvent({ path: '/api/_lukk/logout', method: 'POST', headers: sameOrigin, session }))

    expect(session.clear).toHaveBeenCalledOnce()
  })

  it('passes a JSON null body through', async () => {
    mockFetch().fetch = vi.fn(async () => new Response('null', { status: 200 }))
    await expect(run(makeEvent({ path: '/api/_lukk/user', session: makeSession({ access: 'A' }) }))).resolves.toBe('null')
  })

  it('strips a credential however deeply it is nested', async () => {
    // Capped at four levels, a token five down passed through to the browser — failing open.
    const deep = { a: { b: { c: { d: { e: { f: { refresh_token: 'rt-deep', keep: 1 } } } } } } }
    mockFetch().fetch = vi.fn(async () => jsonRes(deep))
    const body = await run(makeEvent({ path: '/api/_lukk/user', session: makeSession({ access: 'A' }) }))
    expect(JSON.stringify(body)).not.toContain('rt-deep')
    expect(body).toEqual({ a: { b: { c: { d: { e: { f: { keep: 1 } } } } } } })
  })
})

describe('route policy follows the URL lukk receives, not the string the browser sent', () => {
  // The upstream URL collapses dot segments and drops a fragment, and Laravel trims a trailing slash and
  // decodes before routing — so each of these reaches lukk's own route while comparing unequal to it as
  // a string. Policy keyed on the raw string was bypassed by every one of them.
  it.each(['/api/_lukk/./refresh', '/api/_lukk/refresh/', '/api/_lukk/a/../refresh', '/api/_lukk/refresh//', '/api/_lukk/refresh///'])('serves %s as the refresh it is — never proxies it', async (path) => {
    const session = makeSession({ access: 'old', refresh: 'rt-seed' })
    const fetchMock = vi.fn(async () => jsonRes({ access_token: 'new-at', refresh_token: 'rt-1', expires_in: 900 }))
    mockFetch().fetch = fetchMock

    const body = await run(makeEvent({ path, method: 'POST', headers: sameOrigin, body: '{}', session }))

    // One upstream call, carrying the SEALED token: proxied, it would have sent the browser's body and
    // then rotated on the 401 — and the token pair would have come back through the generic path.
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe('https://lukk/auth/refresh')
    expect(String(((fetchMock.mock.calls[0] as unknown[])[1] as { body: string }).body)).toContain('rt-seed')
    expect(body).toEqual({ ok: true, expires_in: 900 })
  })

  it.each(['/api/_lukk//logout', '/api/_lukk/x//refresh', '/api/_lukk/refresh%2F%2F', '/api/_lukk/refresh/%2F', '/api/_lukk/x%2F..%2Frefresh', '/api/_lukk/x%5C..%5Crefresh', '/api/_lukk/logout%252f', '/api/_lukk/refresh%255C'])('refuses %s, a path lukk has no route for but a slash-merging hop might', async (path) => {
    // Policy and forwarding must agree on one URL. Collapsed for the rules but forwarded raw, `//logout`
    // had the sealed refresh token injected and POSTed to a path lukk does not route — to whatever does,
    // an app's fallback route included. lukk has no route with an empty or encoded-slash segment, so
    // such a path is refused before anything is decided or sent.
    const session = makeSession({ access: 'A', refresh: 'rA' })
    const fetchMock = vi.fn(async () => jsonRes(null, 204))
    mockFetch().fetch = fetchMock

    const event = makeEvent({ path, method: 'POST', body: '{}', headers: sameOrigin, session })
    const body = await run(event)

    expect(fetchMock).not.toHaveBeenCalled()
    expect(session.clear).not.toHaveBeenCalled()
    expect(event.status).toBe(404)
    expect(body).toEqual({ message: 'Not found.' })
  })

  it.each(['/api/_lukk/logout/', '/api/_lukk/./logout', '/api/_lukk/x/../logout'])('ends the session on %s like any logout', async (path) => {
    const session = makeSession({ access: 'A', refresh: 'rA' })
    mockFetch().fetch = vi.fn(async () => jsonRes(null, 204))

    await run(makeEvent({ path, method: 'POST', body: 'ignored', headers: sameOrigin, session }))

    const init = mockFetch().fetch.mock.calls[0]![1] as { body: string }
    expect(JSON.parse(init.body)).toEqual({ refresh_token: 'rA' })
    expect(session.clear).toHaveBeenCalledOnce()
  })

  it.each(['/api/_lukk/login/', '/api/_lukk/./register', '/api/_lukk/passkeys/x/../login', '/api/_lukk/two-factor-challenge//'])('passes a 401 from %s straight through, like the sign-in it is', async (path) => {
    const session = makeSession({ access: 'old', refresh: 'rt' })
    mockFetch().fetch = vi.fn().mockResolvedValue(jsonRes({ message: 'Unauthenticated.' }, 401))

    const event = makeEvent({ path, method: 'POST', body: '{}', headers: sameOrigin, session })
    await run(event)

    expect(event.status).toBe(401)
    expect(mockFetch().fetch).toHaveBeenCalledOnce()
    expect(session.update).not.toHaveBeenCalled()
  })

  it('treats an encoded `#` as path data, which neither the policy nor lukk reads as /refresh', async () => {
    // `%23` arrives decoded; left bare, the URL parser dropped it as a fragment and lukk saw `/refresh`.
    const session = makeSession({ access: 'A' })
    mockFetch().fetch = vi.fn(async () => jsonRes({ message: 'Not Found' }, 404))

    await run(makeEvent({ path: '/api/_lukk/refresh#x', method: 'POST', body: '{}', headers: sameOrigin, session }))

    expect(mockFetch().fetch.mock.calls[0]![0]).toBe('https://lukk/auth/refresh%23x')
  })
})

describe('response hygiene', () => {
  it('sends a non-JSON upstream body as text/plain, never as HTML', async () => {
    // A WAF or proxy error page, or anything echoing the request, went out as `text/html` on the APP's
    // origin — a reflected-XSS vector with this app's cookies in scope.
    const event = makeEvent({ path: '/api/_lukk/x', session: makeSession({ access: 'A' }) })
    mockFetch().fetch = vi.fn(async () => new Response('<script>alert(1)</script>', { status: 502, headers: { 'content-type': 'text/html' } }))

    expect(await run(event)).toBe('<script>alert(1)</script>')
    expect(event.__res?.['content-type']).toBe('text/plain; charset=utf-8')
  })

  it('labels a JSON body as JSON, including one h3 would otherwise send as HTML or as no content', async () => {
    const cases: [string, unknown][] = [['{"a":1}', { a: 1 }], ['"<b>hi</b>"', '"<b>hi</b>"'], ['null', 'null'], ['42', '42'], ['true', 'true']]
    for (const [text, expected] of cases) {
      const event = makeEvent({ path: '/api/_lukk/x', session: makeSession({ access: 'A' }) })
      mockFetch().fetch = vi.fn(async () => new Response(text, { status: 200 }))
      expect(await run(event), text).toEqual(expected)
      expect(event.__res?.['content-type'], text).toBe('application/json; charset=utf-8')
    }
  })

  it('answers an empty upstream body as empty text', async () => {
    const event = makeEvent({ path: '/api/_lukk/x', session: makeSession({ access: 'A' }) })
    mockFetch().fetch = vi.fn(async () => new Response(null, { status: 204 }))
    expect(await run(event)).toBe('')
    expect(event.__res?.['content-type']).toBe('text/plain; charset=utf-8')
  })

  it('forbids MIME sniffing on every response, including the ones it refuses', async () => {
    const refused = makeEvent({ path: '/api/_lukk/login', method: 'POST', headers: { origin: 'https://evil.example', host: 'app.example.com' }, session: makeSession() })
    await run(refused)
    expect(refused.status).toBe(403)
    expect(refused.__res?.['x-content-type-options']).toBe('nosniff')

    const escaped = makeEvent({ path: '/api/_lukk/../../etc', session: makeSession() })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await run(escaped)
    expect(escaped.status).toBe(400)
    expect(escaped.__res?.['x-content-type-options']).toBe('nosniff')

    const proxied = makeEvent({ path: '/api/_lukk/x', session: makeSession({ access: 'A' }) })
    mockFetch().fetch = vi.fn(async () => jsonRes({ ok: true }))
    await run(proxied)
    expect(proxied.__res?.['x-content-type-options']).toBe('nosniff')
  })
})

describe('request body size', () => {
  // The body is buffered before anything else happens, on routes an anonymous caller can reach — so an
  // unbounded read let one request hold as much memory as it cared to send.
  it('answers 413 to a declared Content-Length over the limit, without reading or calling lukk', async () => {
    mockFetch().fetch = vi.fn()
    const event = makeEvent({ path: '/api/_lukk/login', method: 'POST', body: '{}', headers: { ...sameOrigin, 'content-length': String(1024 * 1024 + 1) }, session: makeSession() })

    expect(await run(event)).toEqual({ message: 'Request body too large.' })
    expect(event.status).toBe(413)
    expect(mockFetch().fetch).not.toHaveBeenCalled()
  })

  it('answers 411 to a chunked body, which declares no length to bound it by', async () => {
    // Node enforces a declared Content-Length, so chunked coding is the one way to send an unbounded
    // body — and h3 would buffer all of it.
    mockFetch().fetch = vi.fn()
    for (const te of ['chunked', 'gzip, Chunked']) {
      const event = makeEvent({ path: '/api/_lukk/register', method: 'POST', body: '{}', headers: { ...sameOrigin, 'transfer-encoding': te }, session: makeSession() })
      expect(await run(event)).toEqual({ message: 'Length required.' })
      expect(event.status).toBe(411)
    }
    // A declared length bounds it, whatever else the request says.
    const declared = makeEvent({ path: '/api/_lukk/register', method: 'POST', body: '{}', headers: { ...sameOrigin, 'transfer-encoding': 'chunked', 'content-length': '2' }, session: makeSession() })
    mockFetch().fetch = vi.fn(async () => jsonRes({ ok: true }))
    await run(declared)
    expect(declared.status).toBe(200)
  })

  it('answers 413 to a body that turns out larger than the limit once read', async () => {
    // A runtime that hands h3 the body some other way (an edge preset buffers it first) declares
    // nothing Node enforced, so the bytes are measured too.
    mockFetch().fetch = vi.fn()
    const event = makeEvent({ path: '/api/_lukk/register', method: 'POST', body: 'é'.repeat(512 * 1024) + 'x', headers: sameOrigin, session: makeSession() })
    await run(event)
    expect(event.status).toBe(413)
    expect(mockFetch().fetch).not.toHaveBeenCalled()
  })

  it('reads a body of exactly the limit, in bytes, and forwards it intact', async () => {
    mockFetch().fetch = vi.fn(async () => jsonRes({ ok: true }))
    // Bytes, not characters: 512 Ki two-byte characters is exactly 1 MiB.
    const body = 'é'.repeat(512 * 1024)
    const event = makeEvent({ path: '/api/_lukk/register', method: 'POST', body, headers: { ...sameOrigin, 'content-length': String(1024 * 1024) }, session: makeSession() })
    await run(event)
    expect(event.status).toBe(200)
    expect((mockFetch().fetch.mock.calls[0]![1] as { body: string }).body).toBe(body)
  })

  it('takes a configured limit', async () => {
    ;(__test.runtimeConfig.lukk as Record<string, unknown>).bodyLimit = 8
    mockFetch().fetch = vi.fn(async () => jsonRes({ ok: true }))
    const over = makeEvent({ path: '/api/_lukk/login', method: 'POST', body: '123456789', headers: sameOrigin, session: makeSession() })
    await run(over)
    expect(over.status).toBe(413)
    const at = makeEvent({ path: '/api/_lukk/login', method: 'POST', body: '12345678', headers: sameOrigin, session: makeSession() })
    await run(at)
    expect(at.status).toBe(200)
  })
})

describe('a page render\'s own request (`x-lukk-ssr`) never renews the session', () => {
  // Nuxt's SSR `useFetch('/api/_lukk/user')` copies the page request's headers — the session cookie and the
  // render marker. Renewed here, the rotated cookie went back to the render, never to the page, and the
  // browser replayed the consumed token into a revoke. As the app-API proxy does, the 401 goes back as it came.
  const marked = { ...sameOrigin, 'x-lukk-ssr': '1' }

  it('passes a 401 through instead of rotating and retrying', async () => {
    const session = makeSession({ access: 'A', refresh: 'rA', sid: 'render-A' } as TokenSession)
    mockFetch().fetch = vi.fn(async () => jsonRes({ message: 'Unauthenticated.' }, 401))
    const event = makeEvent({ path: '/api/_lukk/user', headers: marked, session })

    await run(event)

    expect(event.status).toBe(401)
    expect(mockFetch().fetch).toHaveBeenCalledOnce()
    expect(session.update).not.toHaveBeenCalled()
  })

  it('answers /refresh 401 without rotating — and without clearing the session', async () => {
    const session = makeSession({ access: 'A', refresh: 'rA', sid: 'render-B' } as TokenSession)
    mockFetch().fetch = vi.fn()
    const event = makeEvent({ path: '/api/_lukk/refresh', method: 'POST', body: '{}', headers: marked, session })

    await expect(run(event)).resolves.toEqual({ message: 'Unauthenticated.' })

    expect(event.status).toBe(401)
    expect(mockFetch().fetch).not.toHaveBeenCalled()
    expect(session.update).not.toHaveBeenCalled()
    expect(session.clear).not.toHaveBeenCalled()
  })

  it('still renews for a logout, which ends the session anyway — so lukk can revoke it', async () => {
    const session = makeSession({ access: 'A', refresh: 'rA', sid: 'render-C' } as TokenSession)
    mockFetch().fetch = vi.fn(async (url: string, init: { headers?: Record<string, string> }) => {
      if (String(url).endsWith('/refresh')) return jsonRes({ access_token: 'A2', refresh_token: 'rA2', expires_in: 900 })
      return init.headers?.Authorization === 'Bearer A2' ? new Response(null, { status: 204 }) : jsonRes({ message: 'Unauthenticated.' }, 401)
    })
    const event = makeEvent({ path: '/api/_lukk/logout', method: 'POST', body: '{}', headers: marked, session })

    await run(event)

    const calls = mockFetch().fetch.mock.calls.map(([url]) => String(url).replace('https://lukk/auth', ''))
    expect(calls).toEqual(['/logout', '/refresh', '/logout'])
  })
})
