import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __test } from './mocks/imports'

// Track read-write session opens so a test can assert the read-only path never mints a cookie.
const h3state = vi.hoisted(() => ({ useSessionCalls: 0 }))
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
  setResponseStatus: (event: { status: number }, status: number) => { event.status = status },
  useSession: async (event: { __session: unknown }) => { h3state.useSessionCalls++; return event.__session },
}))

// eslint-disable-next-line import/first
import handler from '../src/runtime/server/bff'

interface TokenSession { access?: string, refresh?: string, confirmation?: string }

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
  return { path: o.path, method: o.method ?? 'GET', body: o.body, headers: o.headers ?? {}, __session: o.session, __cookiePresent: o.cookiePresent ?? true, __sealTampered: o.sealTampered ?? false, __sealNoData: o.sealNoData ?? false, status: 200 }
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
})
afterEach(() => { __test.reset(); vi.restoreAllMocks() })

describe('BFF proxy', () => {
  it('captures + strips tokens on login (no Bearer yet, content-type forwarded)', async () => {
    const session = makeSession()
    mockFetch().fetch = vi.fn().mockResolvedValue(jsonRes({ access_token: 'a', refresh_token: 'r', expires_in: 900 }))

    const result = await run(makeEvent({ path: '/api/_lukk/login', method: 'POST', body: '{"email":"e"}', headers: { ...sameOrigin, 'content-type': 'application/json' }, session }))

    expect(session.update).toHaveBeenCalledWith({ access: 'a', refresh: 'r' })
    expect(result).toEqual({ ok: true, expires_in: 900 })
    const init = mockFetch().fetch.mock.calls[0]![1]!
    expect(init.headers['Content-Type']).toBe('application/json')
    expect(init.headers.Authorization).toBeUndefined()
  })

  it('keeps the existing refresh token when a response omits it', async () => {
    const session = makeSession({ refresh: 'existing' })
    mockFetch().fetch = vi.fn().mockResolvedValue(jsonRes({ access_token: 'a', expires_in: 900 }))
    await run(makeEvent({ path: '/api/_lukk/login', method: 'POST', headers: sameOrigin, session }))
    expect(session.update).toHaveBeenCalledWith({ access: 'a', refresh: 'existing' })
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

  it('keeps the refresh token when the refresh response omits it', async () => {
    const session = makeSession({ access: 'old', refresh: 'rt' })
    mockFetch().fetch = vi.fn(async (url: string, init?: { headers?: Record<string, string> }) =>
      String(url).endsWith('/refresh')
        ? jsonRes({ access_token: 'new', expires_in: 900 })
        : (init?.headers?.Authorization === 'Bearer new' ? jsonRes({ ok: true }) : jsonRes({ message: 'x' }, 401)))
    await run(makeEvent({ path: '/api/_lukk/data', session }))
    expect(session.update).toHaveBeenCalledWith({ access: 'new', refresh: 'rt' })
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

  it('clears the session on logout', async () => {
    const session = makeSession({ access: 'tok' })
    mockFetch().fetch = vi.fn().mockResolvedValue(jsonRes(null, 204))
    await run(makeEvent({ path: '/api/_lukk/logout', method: 'POST', headers: sameOrigin, session }))
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
  it('rejects a path that escapes the lukk base (traversal)', async () => {
    const session = makeSession({ access: 'tok' })
    mockFetch().fetch = vi.fn()
    const event = makeEvent({ path: '/api/_lukk/../../admin', session })
    await run(event)
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

  it('rejects when the configured base URL is invalid', async () => {
    __test.runtimeConfig.lukk = { baseURL: 'not-a-url', sessionPassword: 'p'.repeat(32) } as unknown as Record<string, unknown>
    const session = makeSession({ access: 'tok' })
    mockFetch().fetch = vi.fn()
    const event = makeEvent({ path: '/api/_lukk/x', session })
    await run(event)
    expect(event.status).toBe(400)
    expect(mockFetch().fetch).not.toHaveBeenCalled()
  })
})
