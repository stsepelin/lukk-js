import { afterEach, describe, expect, it, vi } from 'vitest'
import { refreshOnce } from '../src/runtime/server/utils/refresh'

afterEach(() => vi.restoreAllMocks())

describe('refreshOnce with an unusable baseURL', () => {
  it('returns null (not refreshable) instead of fetching a null target', async () => {
    // The module rejects such a baseURL at build, so this is only reachable via a runtime override
    // (NUXT_LUKK_BASE_URL). It must fail as "not refreshable" — never as an unreadable fetch throw,
    // and never by hitting the network with an unresolved target.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('fetch must not be called with an unresolved target')
    })

    const result = await refreshOnce({ id: 'sid', data: { refresh: 'rt' } }, 'undefined/auth')

    expect(result.pair).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(String(error.mock.calls[0]![0])).toContain('undefined/auth')
  })

  it('masks credentials and reports once per value, like the proxy path', async () => {
    // An UNUSABLE base can still carry credentials — this one fails on the port, not the userinfo —
    // and this path runs per SSR render and per app-API request with an aged token, so logging the
    // raw value on every attempt would spill credentials into server logs repeatedly.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const base = `https://user:hunter2@api.example.com:99999/auth-${Math.random()}`

    for (let i = 0; i < 4; i++) {
      expect((await refreshOnce({ id: 'sid', data: { refresh: 'rt' } }, base)).pair).toBeNull()
    }

    expect(error).toHaveBeenCalledOnce()
    expect(String(error.mock.calls[0]![0])).not.toContain('hunter2')
    expect(String(error.mock.calls[0]![0])).toContain('***@api.example.com')
  })
})

describe('refreshOnce single-flight identity', () => {
  it('keys on the session\'s own sid, so a new session never joins a refresh for the one it replaced', async () => {
    // A sign-in re-seals the NEW session under the OLD h3 id. Keyed on that id, a refresh for the new
    // session joined one still out for the old — and sealed the old session's tokens under the new one.
    let answer!: (r: Response) => void
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() => new Promise((resolve) => { answer = resolve }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'B2' }), { status: 200 }))
    const h3id = `h3-${Math.random()}`

    const old = refreshOnce({ id: h3id, data: { refresh: 'rA', sid: 'session-A' } }, 'https://lukk/auth')
    const replacement = await refreshOnce({ id: h3id, data: { refresh: 'rB', sid: 'session-B' } }, 'https://lukk/auth')

    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(replacement.pair?.access).toBe('B2')
    answer(new Response(JSON.stringify({ access_token: 'A2' }), { status: 200 }))
    expect((await old).pair?.access).toBe('A2')
  })

  it('collapses refreshes of one session across separately bundled copies of the module', async () => {
    // SSR hydration runs from the Nuxt app's server bundle, the proxies from Nitro's: each has its own
    // copy of this module, and module-level state never saw the other's refresh in flight.
    let answer!: (r: Response) => void
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise((resolve) => { answer = resolve }))
    vi.resetModules()
    const copy = await import('../src/runtime/server/utils/refresh')
    const session = { id: `h3-${Math.random()}`, data: { refresh: 'rA', sid: `s-${Math.random()}` } }

    const fromProxy = refreshOnce(session, 'https://lukk/auth')
    const fromRender = copy.refreshOnce(session, 'https://lukk/auth')
    answer(new Response(JSON.stringify({ access_token: 'A2' }), { status: 200 }))

    expect((await fromRender).pair?.access).toBe('A2')
    expect(await fromProxy).toBe(await fromRender)
    expect(fetchSpy).toHaveBeenCalledOnce()
  })

  it('still collapses concurrent refreshes of the SAME session into one', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ access_token: 'A2' }), { status: 200 }))
    const session = { id: `h3-${Math.random()}`, data: { refresh: 'rA', sid: `s-${Math.random()}` } }

    await Promise.all([refreshOnce(session, 'https://lukk/auth'), refreshOnce(session, 'https://lukk/auth')])

    expect(fetchSpy).toHaveBeenCalledOnce()
  })
})

describe('refreshOnce client identity', () => {
  const ok = () => new Response(JSON.stringify({ access_token: 'a', refresh_token: 'r2' }), { status: 200 })

  it('forwards the visitor IP so lukk\'s /refresh throttle keys on them, not on this server', async () => {
    // `lukk-refresh` is `->by($request->ip())` at 30/60s. In BFF mode every proxied 401 and every
    // SSR hydration refreshes through here, so without the visitor's address they all share one
    // bucket and a busy deployment throttles itself.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok())

    await refreshOnce({ id: `s-${Math.random()}`, data: { refresh: 'rt' } }, 'https://lukk/auth', '198.51.100.23')

    expect(fetchSpy.mock.calls[0]![1]!.headers).toMatchObject({ 'X-Forwarded-For': '198.51.100.23' })
  })

  it('sends no X-Forwarded-For when no visitor address is known', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok())

    await refreshOnce({ id: `s-${Math.random()}`, data: { refresh: 'rt' } }, 'https://lukk/auth')

    expect((fetchSpy.mock.calls[0]![1]!.headers as Record<string, string>)['X-Forwarded-For']).toBeUndefined()
  })
})
