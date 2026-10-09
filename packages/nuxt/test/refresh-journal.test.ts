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
import { resolveHydrationAccess, withholdIfReplaced } from '../src/runtime/server/hydrate'
// eslint-disable-next-line import/first
import { refreshOnce } from '../src/runtime/server/refresh'
// eslint-disable-next-line import/first
import { endSession } from '../src/runtime/server/ended-sessions'

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

  it('reseals the NEWEST pair when the session rotated the adopted one before the response left', async () => {
    // A straggler adopts t1; another tab rotates t1 → t2 before this response's headers go out. Sealed as
    // adopted, the cookie landed over t2's with t1, already spent.
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response(JSON.stringify({ access_token: 'a1', refresh_token: 't1', expires_in: 900 }), { status: 200 }))
    const rotateMeanwhile = async (sid: string) => {
      fetchSpy.mockImplementationOnce(async () => new Response(JSON.stringify({ access_token: 'a2', refresh_token: 't2', expires_in: 900 }), { status: 200 }))
      await refreshOnce({ id: 'h3', data: { refresh: 't1', sid } }, 'https://lukk.test/auth')
    }
    /** A read-write session that seals into `on`'s response the way h3 does: replacing its own cookie. */
    const sessionOn = (on: H3Event) => ({ id: 'h3', data: { ...sealed }, update: vi.fn(async (pair: TokenSession) => {
      const res = on.node.res
      const others = ([] as string[]).concat((res.getHeader('set-cookie') as string[] | undefined) ?? []).filter(cookie => !cookie.startsWith('__Host-lukk-session='))
      res.setHeader('set-cookie', [...others, `__Host-lukk-session=${pair.refresh}`])
    }) })
    const proxyAnswering = (meanwhile: () => Promise<void>) => proxyRequest.mockImplementationOnce(async (ev: unknown, _target: string, opts: { onResponse?: (e: unknown, r: unknown) => Promise<void> }) => {
      await meanwhile()
      // Like h3's `sendProxy`: the upstream's cookies replace whatever was queued.
      ;(ev as H3Event).node.res.setHeader('set-cookie', ['upstream=1'])
      await opts.onResponse!(ev, { status: 200, type: 'basic', headers: new Headers() })
      return {}
    })

    // The app-API proxy: re-resolved when the upstream's headers arrive.
    const apiSid = `newest-api-${Math.random()}`
    await refreshOnce({ id: 'h3', data: { refresh: 't0', sid: apiSid } }, 'https://lukk.test/auth')
    sealed = { access: expired(), refresh: 't0', sid: apiSid }
    const proxied = event()
    proxied.node.res.setHeader('set-cookie', ['other=1']) // queued before this handler: it stays
    rw = sessionOn(proxied)
    proxyAnswering(() => rotateMeanwhile(apiSid))
    await (apiProxy as unknown as (e: H3Event) => Promise<unknown>)(proxied)
    expect(rw.update.mock.calls.map(call => call[0])).toEqual([{ access: 'a1', refresh: 't1' }, { access: 'a2', refresh: 't2' }])
    expect(proxied.node.res.getHeader('set-cookie')).toEqual(['other=1', '__Host-lukk-session=t2'])

    // A logout this request finished, replaced by a sign-in meanwhile: none of our cookies leave — the
    // re-seal included.
    const droppedSid = `dropped-api-${Math.random()}`
    await refreshOnce({ id: 'h3', data: { refresh: 't0', sid: droppedSid } }, 'https://lukk.test/auth')
    sealed = { access: expired(), refresh: 't0', sid: droppedSid }
    const dropped = event()
    const endedKey = `finished-${Math.random()}`
    ;(dropped.context as Record<string, unknown>).lukkEndedSession = { key: endedKey, marker: '__Host-lukk-signed-out', session: '__Host-lukk-session' }
    await endSession(endedKey, { replaced: true })
    rw = sessionOn(dropped)
    proxyAnswering(() => rotateMeanwhile(droppedSid))
    await (apiProxy as unknown as (e: H3Event) => Promise<unknown>)(dropped)
    expect(dropped.node.res.getHeader('set-cookie')).toBeUndefined()

    // Nothing rotated meanwhile: sealed once, as adopted.
    const quietSid = `quiet-api-${Math.random()}`
    await refreshOnce({ id: 'h3', data: { refresh: 't0', sid: quietSid } }, 'https://lukk.test/auth')
    sealed = { access: expired(), refresh: 't0', sid: quietSid }
    const quiet = event()
    rw = sessionOn(quiet)
    proxyAnswering(async () => {})
    await (apiProxy as unknown as (e: H3Event) => Promise<unknown>)(quiet)
    expect(rw.update).toHaveBeenCalledOnce()
    expect(quiet.node.res.getHeader('set-cookie')).toEqual(['__Host-lukk-session=t1'])

    // SSR hydration: re-resolved when the render is done, before the page's headers go out.
    const ssrSid = `newest-ssr-${Math.random()}`
    await refreshOnce({ id: 'h3', data: { refresh: 't0', sid: ssrSid } }, 'https://lukk.test/auth')
    sealed = { access: expired(), refresh: 't0', sid: ssrSid }
    const page = event('/dashboard')
    rw = sessionOn(page)
    expect(await resolveHydrationAccess(page)).toBe('a1')
    await withholdIfReplaced(page) // nothing newer yet: no second seal
    expect(rw.update).toHaveBeenCalledOnce()
    await rotateMeanwhile(ssrSid)
    await withholdIfReplaced(page)
    expect(rw.update.mock.calls.map(call => call[0])).toEqual([{ access: 'a1', refresh: 't1' }, { access: 'a2', refresh: 't2' }])

    // …but not once the page's headers are out: touching them would throw.
    const streamedSid = `newest-streamed-${Math.random()}`
    await refreshOnce({ id: 'h3', data: { refresh: 't0', sid: streamedSid } }, 'https://lukk.test/auth')
    sealed = { access: expired(), refresh: 't0', sid: streamedSid }
    const streamed = event('/dashboard')
    rw = sessionOn(streamed)
    await resolveHydrationAccess(streamed)
    await rotateMeanwhile(streamedSid)
    ;(streamed.node.res as { headersSent?: boolean }).headersSent = true
    await withholdIfReplaced(streamed)
    expect(rw.update).toHaveBeenCalledOnce()

    // …nor does a response that started while it was sealing fail the render: it keeps the seal it had.
    const racingSid = `newest-racing-${Math.random()}`
    await refreshOnce({ id: 'h3', data: { refresh: 't0', sid: racingSid } }, 'https://lukk.test/auth')
    sealed = { access: expired(), refresh: 't0', sid: racingSid }
    const racing = event('/dashboard')
    rw = sessionOn(racing)
    await resolveHydrationAccess(racing)
    await rotateMeanwhile(racingSid)
    rw.update.mockRejectedValueOnce(Object.assign(new Error('Cannot set headers after they are sent'), { code: 'ERR_HTTP_HEADERS_SENT' }))
    await expect(withholdIfReplaced(racing)).resolves.toBeUndefined()
  })

  it('withholds a re-seal the session has moved past, when the links that led on expired before the response', async () => {
    // t0 R (app-API, or a render) rotates tx → t1; its upstream is slow. t1 S adopts t1. t5 another tab
    // rotates t1 → t2 (that link lasts to 35 s). t90 R's headers arrive: no link for t1 any more, and
    // sealing t1 over the browser's t2 replayed a spent token on its next refresh. Withheld instead.
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const rotations = () => {
      fetchSpy.mockImplementationOnce(async () => new Response(JSON.stringify({ access_token: 'a1', refresh_token: 't1', expires_in: 900 }), { status: 200 }))
        .mockImplementationOnce(async () => new Response(JSON.stringify({ access_token: 'a2', refresh_token: 't2', expires_in: 900 }), { status: 200 }))
    }
    const otherTab = async (sid: string) => {
      await vi.advanceTimersByTimeAsync(5_000)
      await refreshOnce({ id: 'h3', data: { refresh: 't1', sid } }, 'https://lukk.test/auth')
      await vi.advanceTimersByTimeAsync(85_000)
    }
    const sessionOn = (on: H3Event) => ({ id: 'h3', data: { ...sealed }, update: vi.fn(async (pair: TokenSession) => {
      const res = on.node.res
      const others = ([] as string[]).concat((res.getHeader('set-cookie') as string[] | undefined) ?? []).filter(cookie => !cookie.startsWith('__Host-lukk-session='))
      res.setHeader('set-cookie', [...others, `__Host-lukk-session=${pair.refresh}`])
    }) })

    const apiSid = `stale-api-${Math.random()}`
    rotations()
    sealed = { access: expired(), refresh: 'tx', sid: apiSid }
    const r = event()
    r.node.res.setHeader('set-cookie', ['other=1'])
    rw = sessionOn(r)
    proxyRequest.mockImplementationOnce(async (ev: unknown, _target: string, opts: { onResponse?: (e: unknown, x: unknown) => Promise<void> }) => {
      await otherTab(apiSid)
      ;(ev as H3Event).node.res.setHeader('set-cookie', ['upstream=1'])
      await opts.onResponse!(ev, { status: 200, type: 'basic', headers: new Headers() })
      return {}
    })
    await (apiProxy as unknown as (e: H3Event) => Promise<unknown>)(r)
    expect(r.node.res.getHeader('set-cookie')).toEqual(['other=1']) // the browser keeps its t2

    const ssrSid = `stale-ssr-${Math.random()}`
    rotations()
    sealed = { access: expired(), refresh: 'tx', sid: ssrSid }
    const page = event('/dashboard')
    rw = sessionOn(page)
    expect(await resolveHydrationAccess(page)).toBe('a1')
    await otherTab(ssrSid)
    await withholdIfReplaced(page)
    expect(page.node.res.getHeader('set-cookie') ?? []).toEqual([])
  })

  it('withholds a render\'s re-seal when the session ended while it was re-sealing', async () => {
    // The last `sessionEnded` check came before the re-seal: a logout landing during it still left with it.
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(async () => new Response(JSON.stringify({ access_token: 'a1', refresh_token: 't1', expires_in: 900 }), { status: 200 }))
      .mockImplementationOnce(async () => new Response(JSON.stringify({ access_token: 'a2', refresh_token: 't2', expires_in: 900 }), { status: 200 }))
    const sid = `ended-reseal-${Math.random()}`
    sealed = { access: expired(), refresh: 't0', sid }
    const page = event('/dashboard')
    rw = { id: 'h3', data: { ...sealed }, update: vi.fn(async (pair: TokenSession) => {
      page.node.res.setHeader('set-cookie', [`__Host-lukk-session=${pair.refresh}`])
      if (pair.refresh === 't2') await endSession(sid)
    }) }
    await resolveHydrationAccess(page)
    await refreshOnce({ id: 'h3', data: { refresh: 't1', sid } }, 'https://lukk.test/auth')
    await withholdIfReplaced(page)

    expect(rw.update).toHaveBeenCalledTimes(2)
    expect(page.node.res.getHeader('set-cookie') ?? []).toEqual([])
    // And the pair it dropped is revoked, as on the other ended path — the one it just sealed, t2.
    expect(fetchSpy).toHaveBeenCalledTimes(3)
    expect(fetchSpy.mock.calls[2]![0]).toBe('https://lukk.test/auth/logout')
    expect(new Headers(fetchSpy.mock.calls[2]![1]!.headers).get('authorization')).toBe('Bearer a2')
  })

  it('compares a second render-end check against what the first re-sealed — app:error, then app:rendered', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(async () => new Response(JSON.stringify({ access_token: 'a1', refresh_token: 't1', expires_in: 900 }), { status: 200 }))
      .mockImplementationOnce(async () => new Response(JSON.stringify({ access_token: 'a2', refresh_token: 't2', expires_in: 900 }), { status: 200 }))
    const sid = `twice-${Math.random()}`
    sealed = { access: expired(), refresh: 't0', sid }
    const page = event('/dashboard')
    rw = { id: 'h3', data: { ...sealed }, update: vi.fn() }
    await resolveHydrationAccess(page)
    await refreshOnce({ id: 'h3', data: { refresh: 't1', sid } }, 'https://lukk.test/auth')

    await withholdIfReplaced(page)
    await withholdIfReplaced(page)

    expect(rw.update.mock.calls.map(call => call[0])).toEqual([{ access: 'a1', refresh: 't1' }, { access: 'a2', refresh: 't2' }])
  })

  it('drops an app-API re-seal, and revokes it, when the session ended while it was re-sealing', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(async () => new Response(JSON.stringify({ access_token: 'a1', refresh_token: 't1', expires_in: 900 }), { status: 200 }))
      .mockImplementationOnce(async () => new Response(JSON.stringify({ access_token: 'a2', refresh_token: 't2', expires_in: 900 }), { status: 200 }))
      .mockImplementation(async () => new Response(null, { status: 204 }))
    const sid = `api-ended-reseal-${Math.random()}`
    sealed = { access: expired(), refresh: 't0', sid }
    const proxied = event()
    proxied.node.res.setHeader('set-cookie', ['other=1'])
    rw = { id: 'h3', data: { ...sealed }, update: vi.fn(async (pair: TokenSession) => {
      const others = ([] as string[]).concat((proxied.node.res.getHeader('set-cookie') as string[] | undefined) ?? []).filter(cookie => !cookie.startsWith('__Host-lukk-session='))
      proxied.node.res.setHeader('set-cookie', [...others, `__Host-lukk-session=${pair.refresh}`])
      if (pair.refresh === 't2') await endSession(sid)
    }) }
    proxyRequest.mockImplementationOnce(async (ev: unknown, _target: string, opts: { onResponse?: (e: unknown, x: unknown) => Promise<void> }) => {
      await refreshOnce({ id: 'h3', data: { refresh: 't1', sid } }, 'https://lukk.test/auth')
      ;(ev as H3Event).node.res.setHeader('set-cookie', ['upstream=1'])
      await opts.onResponse!(ev, { status: 200, type: 'basic', headers: new Headers() })
      return {}
    })
    await (apiProxy as unknown as (e: H3Event) => Promise<unknown>)(proxied)

    expect(proxied.node.res.getHeader('set-cookie')).toEqual(['other=1'])
    const logout = fetchSpy.mock.calls.find(call => String(call[0]).endsWith('/logout'))!
    expect(new Headers(logout[1]!.headers).get('authorization')).toBe('Bearer a2')
  })
})
