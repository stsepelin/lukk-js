import type { H3Event } from 'h3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __test } from './mocks/imports'
import type { TokenSession } from '../src/runtime/server/refresh'

/**
 * The REAL `refreshOnce` under the two callers whose own suites mock it: the app-API proxy's proactive
 * refresh and SSR hydration. A rotation that landed after every caller gave up must be adopted — and
 * sealed — by whichever of them the browser's next request reaches.
 */
let sealed: TokenSession
let rw: { id: string, data: TokenSession, update: ReturnType<typeof vi.fn> }
const proxyRequest = vi.fn(async (_event: unknown, _target: string, _opts: { headers: Record<string, string> }) => ({}))

vi.mock('h3', () => ({
  defineEventHandler: (fn: unknown) => fn,
  getRequestHeader: (event: { headers?: Record<string, string> }, name: string) => event.headers?.[name],
  getCookie: (_event: unknown, name: string) => (/-logout$|-signed-out$/.test(name) ? undefined : 'sealed'),
  unsealSession: async () => ({ id: 'h3', data: { ...sealed } }),
  useSession: async () => rw,
  sealSession: async () => 'FRESH',
  setResponseHeader: () => {},
  setResponseStatus: () => {},
  proxyRequest: (...args: unknown[]) => (proxyRequest as (...a: unknown[]) => unknown)(...args),
}))

// eslint-disable-next-line import/first
import apiProxy from '../src/runtime/server/api-proxy'
// eslint-disable-next-line import/first
import { resolveHydrationAccess } from '../src/runtime/server/hydrate'
// eslint-disable-next-line import/first
import { refreshOnce } from '../src/runtime/server/refresh'

const expired = () => `${Buffer.from('{"alg":"HS256"}').toString('base64url')}.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) - 10 })).toString('base64url')}.sig`

function event(path = '/api/me'): H3Event {
  const res = new Map<string, unknown>()
  return {
    path,
    method: 'GET',
    headers: {},
    context: {},
    node: {
      req: { url: path, headers: { cookie: '__Host-lukk-session=STALE' }, socket: {} },
      res: { getHeader: (k: string) => res.get(k), setHeader: (k: string, v: unknown) => { res.set(k, v) }, removeHeader: (k: string) => { res.delete(k) } },
    },
  } as unknown as H3Event
}

/** A rotation lukk answers at 20 s — after the 15 s its caller waited — for the session `sid`. */
async function lateRotation(sid: string) {
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise((resolve) => {
    setTimeout(() => resolve(new Response(JSON.stringify({ access_token: 'late-at', refresh_token: 'late-rt', expires_in: 900 }), { status: 200 })), 20_000)
  }))
  const first = refreshOnce({ id: 'h3', data: { refresh: 'old-rt', sid } }, 'https://lukk.test/auth')
  await vi.advanceTimersByTimeAsync(15_000)
  await expect(first).resolves.toMatchObject({ pair: null, retryAfter: 5 })
  await vi.advanceTimersByTimeAsync(60_000)
  return fetchSpy
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  __test.runtimeConfig.lukk = { apiPath: '/api', apiTarget: 'https://app.test', apiForceJson: true, baseURL: 'https://lukk.test/auth', sessionPassword: 'p'.repeat(32) } as unknown as Record<string, unknown>
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); proxyRequest.mockClear(); __test.reset() })

describe('a rotation nobody received, adopted by the next request', () => {
  it('through the app-API proxy: sealed, and its access token injected', async () => {
    const sid = `api-${Math.random()}`
    const fetchSpy = await lateRotation(sid)
    sealed = { access: expired(), refresh: 'old-rt', sid }
    rw = { id: 'h3', data: { ...sealed }, update: vi.fn() }

    await (apiProxy as unknown as (e: H3Event) => Promise<unknown>)(event())

    expect(rw.update).toHaveBeenCalledWith({ access: 'late-at', refresh: 'late-rt' })
    expect(proxyRequest.mock.calls[0]![2].headers.authorization).toBe('Bearer late-at')
    expect(fetchSpy).toHaveBeenCalledOnce()
  })

  it('through SSR hydration: sealed, and the render hydrated with it', async () => {
    const sid = `ssr-${Math.random()}`
    const fetchSpy = await lateRotation(sid)
    sealed = { access: expired(), refresh: 'old-rt', sid }
    rw = { id: 'h3', data: { ...sealed }, update: vi.fn() }

    expect(await resolveHydrationAccess(event('/dashboard'))).toBe('late-at')

    expect(rw.update).toHaveBeenCalledWith({ access: 'late-at', refresh: 'late-rt' })
    expect(fetchSpy).toHaveBeenCalledOnce()
  })

  it('a rotation a request DID receive: adopted within the window, through both', async () => {
    // One request of a burst renewed the session; the others, already out with the old cookie, come back.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ access_token: 'got-at', refresh_token: 'got-rt', expires_in: 900 }), { status: 200 }))
    const sid = `received-${Math.random()}`
    expect((await refreshOnce({ id: 'h3', data: { refresh: 'old-rt', sid } }, 'https://lukk.test/auth')).pair?.access).toBe('got-at')
    await vi.advanceTimersByTimeAsync(10_000)

    sealed = { access: expired(), refresh: 'old-rt', sid }
    rw = { id: 'h3', data: { ...sealed }, update: vi.fn() }
    await (apiProxy as unknown as (e: H3Event) => Promise<unknown>)(event())
    expect(rw.update).toHaveBeenCalledWith({ access: 'got-at', refresh: 'got-rt' })
    expect(proxyRequest.mock.calls[0]![2].headers.authorization).toBe('Bearer got-at')

    rw = { id: 'h3', data: { ...sealed }, update: vi.fn() }
    expect(await resolveHydrationAccess(event('/dashboard'))).toBe('got-at')
    expect(rw.update).toHaveBeenCalledWith({ access: 'got-at', refresh: 'got-rt' })
    expect(fetchSpy).toHaveBeenCalledOnce()
  })
})
