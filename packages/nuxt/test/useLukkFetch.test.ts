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
    __test.requestHeaders = { cookie: '__Host-lukk-session=sealed' }
    useLukkFetch()
    expect(deps().getCookieHeader()).toBe('__Host-lukk-session=sealed')
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
})
