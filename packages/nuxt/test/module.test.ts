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

interface FakeNuxt { options: { runtimeConfig: { public: Record<string, unknown> } & Record<string, unknown> } & Record<string, unknown> }

function setup(overrides: Record<string, unknown>, nuxtOptions: Record<string, unknown> = {}): FakeNuxt {
  const nuxt: FakeNuxt = { options: { runtimeConfig: { public: {} }, ...nuxtOptions } }
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

  it('makes the session cookie Secure by default (production build)', () => {
    const nuxt = setup({ baseURL: 'https://api/auth', mode: 'bff' }) // no nuxt.options.dev → prod
    expect((nuxt.options.runtimeConfig.lukk as { cookieSecure: boolean }).cookieSecure).toBe(true)
  })

  it('relaxes the session cookie for `nuxi dev` over http', () => {
    const nuxt = setup({ baseURL: 'https://api/auth', mode: 'bff' }, { dev: true })
    expect((nuxt.options.runtimeConfig.lukk as { cookieSecure: boolean }).cookieSecure).toBe(false)
  })

  it('keeps the session cookie Secure under `nuxi dev --https`', () => {
    const nuxt = setup({ baseURL: 'https://api/auth', mode: 'bff' }, { dev: true, devServer: { https: true } })
    expect((nuxt.options.runtimeConfig.lukk as { cookieSecure: boolean }).cookieSecure).toBe(true)
  })

  it('honors an explicit session.cookieSecure override', () => {
    const nuxt = setup({ baseURL: 'https://api/auth', mode: 'bff', session: { password: 'x'.repeat(32), cookieSecure: false } }, { dev: false })
    expect((nuxt.options.runtimeConfig.lukk as { cookieSecure: boolean }).cookieSecure).toBe(false)
  })

  it('skips the proxy and exposes the URL + user endpoint in direct mode', () => {
    const nuxt = setup({ baseURL: 'https://api/auth', mode: 'direct', user: { endpoint: '/me' } })
    expect(kit.addServerHandler).not.toHaveBeenCalled()
    const pub = nuxt.options.runtimeConfig.public.lukk as { baseURL: string, userEndpoint: string, apiBaseURL: string, userKey: string | false }
    expect(pub.baseURL).toBe('https://api/auth')
    expect(pub.userEndpoint).toBe('/me')
    expect(pub.userKey).toBe('data') // default unwrap key
    expect(pub.apiBaseURL).toBe('https://api') // direct → API origin (the /auth prefix is dropped)
  })

  it('passes through a custom user.key (and normalizes false → "" to disable unwrapping)', () => {
    const key = (o: Parameters<typeof setup>[0]) => (setup(o).options.runtimeConfig.public.lukk as { userKey: string }).userKey
    expect(key({ baseURL: 'https://api/auth', mode: 'bff', user: { endpoint: '/me', key: 'result' } })).toBe('result')
    expect(key({ baseURL: 'https://api/auth', mode: 'bff', user: { endpoint: '/me', key: false } })).toBe('')
  })

  it('derives apiBaseURL: proxy mount (bff), api.target, or empty when unconfigured', () => {
    const pub = (o: Parameters<typeof setup>[0]) => (setup(o).options.runtimeConfig.public.lukk as { apiBaseURL: string }).apiBaseURL
    expect(pub({ baseURL: 'https://api/auth', mode: 'bff', api: { path: '/api', target: 'https://laravel.test' } })).toBe('/api')
    expect(pub({ baseURL: 'https://api/auth', mode: 'bff' })).toBe('') // no api.path → relative root
    expect(pub({ baseURL: 'https://api/auth', mode: 'direct', api: { target: 'https://app.test/api' } })).toBe('https://app.test/api')
  })

  it('always wires composables, middleware, plugins, and the server helpers', () => {
    setup({ baseURL: 'https://api/auth', mode: 'direct' })
    expect(kit.addImportsDir).toHaveBeenCalledOnce()
    expect(kit.addRouteMiddleware).toHaveBeenCalledTimes(4) // lukk-auth + lukk-guest + lukk-verified + lukk-confirmed
    expect(kit.addPlugin).toHaveBeenCalledTimes(2) // client + session.client
    expect(kit.addServerImportsDir).toHaveBeenCalledOnce() // getLukkAccessToken / useLukkSession
  })

  it('registers the SSR-hydration server plugin in bff mode by default, and skips it with ssrHydrate: false', () => {
    setup({ baseURL: 'https://api/auth', mode: 'bff' })
    expect(kit.addPlugin).toHaveBeenCalledTimes(3) // client + session.client + session.server
    expect(kit.addPlugin).toHaveBeenCalledWith(expect.objectContaining({ src: expect.stringContaining('session.server'), mode: 'server' }))

    vi.clearAllMocks()
    setup({ baseURL: 'https://api/auth', mode: 'bff', ssrHydrate: false })
    expect(kit.addPlugin).toHaveBeenCalledTimes(2) // client + session.client only
    expect(kit.addPlugin).not.toHaveBeenCalledWith(expect.objectContaining({ mode: 'server' }))
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

  it('passes api.forwardSetCookie into runtimeConfig (default empty)', () => {
    const dflt = setup({ baseURL: 'https://api/auth', mode: 'bff', api: { path: '/api', target: 'https://laravel.test' } })
    expect((dflt.options.runtimeConfig.lukk as { apiForwardSetCookie: string[] }).apiForwardSetCookie).toEqual([])
    const set = setup({ baseURL: 'https://api/auth', mode: 'bff', api: { path: '/api', target: 'https://laravel.test', forwardSetCookie: ['locale'] } })
    expect((set.options.runtimeConfig.lukk as { apiForwardSetCookie: string[] }).apiForwardSetCookie).toEqual(['locale'])
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

  it('warns on a half-configured app-API proxy (path XOR target), but not when both/neither are set', () => {
    const warned = (o: Parameters<typeof setup>[0]) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      setup({ baseURL: 'https://api/auth', ...o })
      const hit = warn.mock.calls.some(c => String(c[0]).includes('app-API proxy needs BOTH'))
      warn.mockRestore()
      return hit
    }
    expect(warned({ mode: 'bff', api: { path: '/api' } })).toBe(true) // target missing
    expect(warned({ mode: 'bff', api: { target: 'https://laravel.test' } })).toBe(true) // path missing
    expect(warned({ mode: 'bff', api: { path: '/api', target: 'https://laravel.test' } })).toBe(false) // both
    expect(warned({ mode: 'bff' })).toBe(false) // neither (valid BFF-without-proxy)
  })
})
