import { beforeEach, describe, expect, it, vi } from 'vitest'
import { __test, useState } from './mocks/imports'
import { ACCESS_KEY } from '../src/runtime/keys'
import { createLukkFetch } from '../src/runtime/utils/create-lukk-fetch'
import { useLukkFetch } from '../src/runtime/composables/useLukkFetch'

// The factory is unit-tested separately; here we only assert the composable wires
// the right transport-aware deps from config + state. Keep the real `resolveServerBase`.
vi.mock('../src/runtime/utils/create-lukk-fetch', async importActual => ({
  ...(await importActual<typeof import('../src/runtime/utils/create-lukk-fetch')>()),
  createLukkFetch: vi.fn(),
}))

beforeEach(() => {
  __test.reset()
  vi.mocked(createLukkFetch).mockReset().mockReturnValue('FETCH' as never)
})

const deps = () => vi.mocked(createLukkFetch).mock.calls[0]![0]

describe('useLukkFetch', () => {
  it('returns the built fetch instance', () => {
    __test.runtimeConfig.public.lukk = { mode: 'bff', apiBaseURL: '/api' }
    expect(useLukkFetch()).toBe('FETCH')
  })

  it('BFF: baseURL from apiBaseURL, no bearer, no client-side refresh', () => {
    __test.runtimeConfig.public.lukk = { mode: 'bff', apiBaseURL: '/api' }
    useLukkFetch()
    const d = deps()
    expect(d.baseURL).toBe('/api')
    expect(d.canRefresh).toBe(false)
    expect(d.getBearer()).toBeNull()
    expect(d.getCookieHeader()).toBeUndefined() // client (import.meta.server=false)
  })

  it('BFF: the app-API base sits under the app\'s own base path', () => {
    __test.runtimeConfig.public.lukk = { mode: 'bff', apiBaseURL: '/api' }
    ;(__test.runtimeConfig as { app?: unknown }).app = { baseURL: '/admin/' }
    useLukkFetch()
    expect(deps().baseURL).toBe('/admin/api')
  })

  it('direct: a relative API base is the API\'s own path on this origin, not a route of this app', () => {
    // In direct mode `api.target` names where the API lives — `/api` there is a server beside this app on
    // the same origin, not a Nitro route under its base. Prefixing the app base sent every call to
    // `/admin/api`, which nothing serves.
    __test.runtimeConfig.public.lukk = { mode: 'direct', apiBaseURL: '/api' }
    ;(__test.runtimeConfig as { app?: unknown }).app = { baseURL: '/admin/' }
    useLukkFetch()
    expect(deps().baseURL).toBe('/api')
  })

  it('direct: an absolute API base is left as it is', () => {
    __test.runtimeConfig.public.lukk = { mode: 'direct', apiBaseURL: 'https://api.test' }
    ;(__test.runtimeConfig as { app?: unknown }).app = { baseURL: '/admin/' }
    useLukkFetch()
    expect(deps().baseURL).toBe('https://api.test')
  })

  it('reports this app\'s origin, and nothing where there is no request to read it from', () => {
    __test.runtimeConfig.public.lukk = { mode: 'bff', apiBaseURL: '/api' }
    __test.requestURL = 'https://app.test/dashboard'
    useLukkFetch()
    expect(deps().origin).toBe('https://app.test')

    // Outside a request, `useRequestURL` throws — the origin is simply unknown, and an absolute per-call
    // `baseURL` then stays refused rather than being cleared against a guess.
    __test.requestURL = 'not a url'
    useLukkFetch()
    expect(vi.mocked(createLukkFetch).mock.calls.at(-1)![0].origin).toBeUndefined()
  })

  it('direct: canRefresh on the client, bearer from the access state', () => {
    __test.runtimeConfig.public.lukk = { mode: 'direct', apiBaseURL: 'https://api.example.com' }
    useState<string | null>(ACCESS_KEY, () => null).value = 'tok'
    useLukkFetch()
    const d = deps()
    expect(d.baseURL).toBe('https://api.example.com')
    expect(d.canRefresh).toBe(true)
    expect(d.getBearer()).toBe('tok')
  })

  it('captures the request cookie eagerly (from useRequestHeaders)', () => {
    __test.runtimeConfig.public.lukk = { mode: 'bff', apiBaseURL: '/api' }
    __test.requestHeaders = { cookie: '__Host-lukk-session=sealed', authorization: 'Bearer forged' }
    useLukkFetch()
    expect(deps().getCookieHeader()).toBe('__Host-lukk-session=sealed')
  })

  it('knows it is running in the browser', () => {
    __test.runtimeConfig.public.lukk = { mode: 'direct', apiBaseURL: 'https://api.example.com' }
    useLukkFetch()
    expect(deps().isServer).toBe(false)
  })

  it('refresh delegates to $lukkRefresh, and resolves null when absent', async () => {
    const $lukkRefresh = vi.fn(async () => ({ ok: true }))
    __test.runtimeConfig.public.lukk = { mode: 'direct', apiBaseURL: '/x' }
    __test.nuxtApp = { $lukkRefresh }
    useLukkFetch()
    await expect(deps().refresh()).resolves.toEqual({ ok: true })
    expect($lukkRefresh).toHaveBeenCalledTimes(1)

    __test.nuxtApp = {}
    vi.mocked(createLukkFetch).mockClear()
    useLukkFetch()
    await expect(deps().refresh()).resolves.toBeNull()
  })

  it('onRedirect navigates externally', () => {
    __test.runtimeConfig.public.lukk = { mode: 'bff', apiBaseURL: '/api' }
    useLukkFetch()
    deps().onRedirect('/login')
    expect(__test.navigated).toBe('/login')
    expect(__test.navigatedOptions).toEqual({ external: true })
  })

  it('refuses to follow a redirect off the API origin', () => {
    // `external: true` opts out of Nuxt's absolute-URL block, so this is the one place a
    // server-controlled string becomes a navigation. Contain it here rather than trust the caller.
    __test.runtimeConfig.public.lukk = { mode: 'direct', apiBaseURL: 'https://api.example.com' }
    useLukkFetch()
    __test.navigated = undefined

    deps().onRedirect('https://evil.test/steal')

    expect(__test.navigated).toBeUndefined()
  })
})
