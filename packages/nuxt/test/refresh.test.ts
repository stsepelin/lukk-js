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
