import { afterEach, describe, expect, it, vi } from 'vitest'

const kit = vi.hoisted(() => ({
  addImportsDir: vi.fn(),
  addPlugin: vi.fn(),
  addRouteMiddleware: vi.fn(),
  addServerHandler: vi.fn(),
  addServerImportsDir: vi.fn(),
  createResolver: () => ({ resolve: (p: string) => p }),
  defineNuxtModule: (def: unknown) => def,
}))
vi.mock('@nuxt/kit', () => kit)

// eslint-disable-next-line import/first
import lukkModule from '../src/module'

interface FakeNuxt { options: { runtimeConfig: { public: Record<string, unknown> } & Record<string, unknown> } }

function setup(overrides: Record<string, unknown>): FakeNuxt {
  const nuxt: FakeNuxt = { options: { runtimeConfig: { public: {} } } }
  const mod = lukkModule as unknown as { defaults: Record<string, unknown>, setup: (o: unknown, n: FakeNuxt) => void }
  const opts: Record<string, unknown> = { ...mod.defaults, ...overrides }
  // Model Nuxt's deep-merge of nested option objects (so e.g. api.forceJson defaults apply).
  for (const k of ['api', 'user', 'session']) {
    if (overrides[k]) opts[k] = { ...(mod.defaults[k] as object), ...(overrides[k] as object) }
  }
  mod.setup(opts, nuxt)
  return nuxt
}

afterEach(() => vi.clearAllMocks())

describe('lukk-nuxt module', () => {
  it('registers the BFF proxy and hides the lukk URL from the client in bff mode', () => {
    const nuxt = setup({ baseURL: 'https://api/auth', mode: 'bff' })
    expect(kit.addServerHandler).toHaveBeenCalledOnce()
    expect((nuxt.options.runtimeConfig.public.lukk as { baseURL: string }).baseURL).toBe('')
    expect((nuxt.options.runtimeConfig.lukk as { baseURL: string }).baseURL).toBe('https://api/auth')
  })

  it('skips the proxy and exposes the URL + user endpoint in direct mode', () => {
    const nuxt = setup({ baseURL: 'https://api/auth', mode: 'direct', user: { endpoint: '/me' } })
    expect(kit.addServerHandler).not.toHaveBeenCalled()
    const pub = nuxt.options.runtimeConfig.public.lukk as { baseURL: string, userEndpoint: string }
    expect(pub.baseURL).toBe('https://api/auth')
    expect(pub.userEndpoint).toBe('/me')
  })

  it('always wires composables, middleware, plugins, and the server helpers', () => {
    setup({ baseURL: 'https://api/auth', mode: 'direct' })
    expect(kit.addImportsDir).toHaveBeenCalledOnce()
    expect(kit.addRouteMiddleware).toHaveBeenCalledTimes(2) // lukk-auth + lukk-guest
    expect(kit.addPlugin).toHaveBeenCalledTimes(2) // client + session.client
    expect(kit.addServerImportsDir).toHaveBeenCalledOnce() // getLukkAccessToken / useLukkSession
  })

  it('registers the app-API proxy when api.{path,target} are set in bff mode', () => {
    const nuxt = setup({ baseURL: 'https://api/auth', mode: 'bff', api: { path: '/api', target: 'https://laravel.test' } })
    // bff proxy + app proxy
    expect(kit.addServerHandler).toHaveBeenCalledTimes(2)
    expect(kit.addServerHandler).toHaveBeenCalledWith(expect.objectContaining({ route: '/api/**' }))
    const cfg = nuxt.options.runtimeConfig.lukk as { apiTarget: string, apiPath: string, apiForceJson: boolean }
    expect(cfg.apiTarget).toBe('https://laravel.test')
    expect(cfg.apiPath).toBe('/api')
    expect(cfg.apiForceJson).toBe(true) // default
  })

  it('passes through api.forceJson when set to false', () => {
    const nuxt = setup({ baseURL: 'https://api/auth', mode: 'bff', api: { path: '/api', target: 'https://laravel.test', forceJson: false } })
    expect((nuxt.options.runtimeConfig.lukk as { apiForceJson: boolean }).apiForceJson).toBe(false)
  })

  it('does not register the app-API proxy without api config (bff)', () => {
    setup({ baseURL: 'https://api/auth', mode: 'bff' })
    expect(kit.addServerHandler).toHaveBeenCalledOnce() // just the bff proxy
  })

  it('normalizes a trailing slash on api.path', () => {
    const nuxt = setup({ baseURL: 'https://api/auth', mode: 'bff', api: { path: '/api/', target: 'https://laravel.test' } })
    expect(kit.addServerHandler).toHaveBeenCalledWith(expect.objectContaining({ route: '/api/**' })) // not /api//**
    expect((nuxt.options.runtimeConfig.lukk as { apiPath: string }).apiPath).toBe('/api')
  })

  it('does not register the app-API proxy in direct mode even with api config', () => {
    setup({ baseURL: 'https://api/auth', mode: 'direct', api: { path: '/api', target: 'https://laravel.test' } })
    expect(kit.addServerHandler).not.toHaveBeenCalled()
  })

  it('warns when baseURL is empty', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    setup({ baseURL: '', mode: 'direct' })
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
