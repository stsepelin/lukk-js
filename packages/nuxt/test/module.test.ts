import { afterEach, describe, expect, it, vi } from 'vitest'

const kit = vi.hoisted(() => ({
  addImportsDir: vi.fn(),
  addPlugin: vi.fn(),
  addRouteMiddleware: vi.fn(),
  addServerHandler: vi.fn(),
  addServerImportsDir: vi.fn(),
  addServerPlugin: vi.fn(),
  addTypeTemplate: vi.fn(),
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
    expect(kit.addServerHandler).toHaveBeenCalledTimes(2)
    expect(kit.addServerHandler).toHaveBeenCalledWith(expect.objectContaining({ route: '/api/_lukk/**' }))
    // And the middleware that finishes a logout the browser noted before the page load.
    expect(kit.addServerHandler).toHaveBeenCalledWith(expect.objectContaining({ middleware: true, handler: expect.stringContaining('finish-logout') }))
    expect((nuxt.options.runtimeConfig.public.lukk as { baseURL: string }).baseURL).toBe('')
    expect((nuxt.options.runtimeConfig.lukk as { baseURL: string }).baseURL).toBe('https://api/auth')
  })

  it('warns when a production build turns the Secure flag off — the cookies lose `__Host-` with it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    setup({ baseURL: 'https://api/auth', mode: 'bff', session: { password: 'x'.repeat(32), cookieSecure: false } })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cookieSecure is false in a production build'))

    warn.mockClear()
    setup({ baseURL: 'https://api/auth', mode: 'bff', session: { password: 'x'.repeat(32), cookieSecure: false } }, { dev: true })
    setup({ baseURL: 'https://api/auth', mode: 'bff' })
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('cookieSecure is false'))
  })

  it('scopes the browser-side session bookkeeping by `session.name`, which co-hosted apps differ on', () => {
    const scopeOf = (nuxt: ReturnType<typeof setup>) => (nuxt.options.runtimeConfig.public.lukk as { scope: string }).scope
    expect(scopeOf(setup({ baseURL: 'https://api/auth', mode: 'bff' }))).toBe('')
    expect(scopeOf(setup({ baseURL: 'https://api/auth', mode: 'bff', session: { password: 'x'.repeat(32), name: 'admin' } }))).toBe('admin')
  })

  it('names the logout cookies for the browser from the same Secure flag and namespace as the session', () => {
    const pub = (nuxt: ReturnType<typeof setup>) => nuxt.options.runtimeConfig.public.lukk as { logoutCookie: string, signedOutCookie: string }
    expect(pub(setup({ baseURL: 'https://api/auth', mode: 'bff' }))).toMatchObject({ logoutCookie: '__Host-lukk-logout', signedOutCookie: '__Host-lukk-signed-out' })
    expect(pub(setup({ baseURL: 'https://api/auth', mode: 'bff', session: { password: 'x'.repeat(32), name: 'admin' } }, { dev: true }))).toMatchObject({ logoutCookie: 'lukk-admin-logout', signedOutCookie: 'lukk-admin-signed-out' })
    expect(pub(setup({ baseURL: 'https://api/auth', mode: 'direct' }))).toMatchObject({ logoutCookie: '', signedOutCookie: '' })
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

  it('passes session.name through as cookieNamespace (the cookie name is derived per-request from it + cookieSecure)', () => {
    // The full name is resolved at each runtime site (see shared/bff/hydrate tests) so its `__Host-`
    // prefix stays coupled to the runtime cookieSecure; the module only forwards the namespace.
    const unset = setup({ baseURL: 'https://api/auth', mode: 'bff' })
    expect((unset.options.runtimeConfig.lukk as { cookieNamespace?: string }).cookieNamespace).toBeUndefined()
    const named = setup({ baseURL: 'https://api/auth', mode: 'bff', session: { password: 'x'.repeat(32), name: 'admin' } })
    expect((named.options.runtimeConfig.lukk as { cookieNamespace?: string }).cookieNamespace).toBe('admin')
  })

  it('types the client plugin\'s provides for consumers', () => {
    setup({ baseURL: 'https://api/auth', mode: 'bff' })
    const template = kit.addTypeTemplate.mock.calls[0]![0] as { filename: string, getContents: () => string }

    expect(template.filename).toBe('types/lukk-nuxt.d.ts')
    const contents = template.getContents()
    expect(contents).toContain(`import type { LukkClient, TokenPair } from 'lukk-core'`)
    expect(contents).toContain('$lukk: LukkClient')
    expect(contents).toContain('$lukkRefresh: () => Promise<TokenPair | null>')
  })

  it('registers the streaming-render marker alongside SSR hydration, and not without it', () => {
    setup({ baseURL: 'https://api/auth', mode: 'bff' })
    expect(kit.addServerPlugin).toHaveBeenCalledWith('./runtime/server/plugins/streaming-render')

    kit.addServerPlugin.mockClear()
    setup({ baseURL: 'https://api/auth', mode: 'bff', ssrHydrate: false })
    expect(kit.addServerPlugin).not.toHaveBeenCalledWith('./runtime/server/plugins/streaming-render')
  })

  it('passes session.sharedStore through and registers the plugin that wires it (bff only)', () => {
    const unset = setup({ baseURL: 'https://api/auth', mode: 'bff' })
    expect((unset.options.runtimeConfig.lukk as { sharedStore?: string }).sharedStore).toBe('')
    expect(kit.addServerPlugin).toHaveBeenCalledWith('./runtime/server/plugins/shared-ended-sessions')

    const shared = setup({ baseURL: 'https://api/auth', mode: 'bff', session: { password: 'x'.repeat(32), sharedStore: 'lukk-sessions' } })
    expect((shared.options.runtimeConfig.lukk as { sharedStore?: string }).sharedStore).toBe('lukk-sessions')

    kit.addServerPlugin.mockClear()
    setup({ baseURL: 'https://api/auth', mode: 'direct' })
    expect(kit.addServerPlugin).not.toHaveBeenCalled()
  })

  it('warns on a session.name that is not a cookie-safe slug, but not on a valid one / when unset', () => {
    const warned = (name: string | undefined) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      setup({ baseURL: 'https://api/auth', mode: 'bff', session: { password: 'x'.repeat(32), name } })
      const hit = warn.mock.calls.some(c => String(c[0]).includes('session.name'))
      warn.mockRestore()
      return hit
    }
    expect(warned('admin')).toBe(false) // valid slug
    expect(warned('admin.app')).toBe(false) // '.' is a valid cookie-name char
    expect(warned('a b')).toBe(true) // whitespace breaks the cookie name
    expect(warned('a;b')).toBe(true) // ';' is a cookie separator
    expect(warned(undefined)).toBe(false) // unset → no warning
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
    // The last check on a page whose request finished a logout — BFF, whatever ssrHydrate says.
    expect(kit.addServerPlugin).toHaveBeenCalledWith(expect.stringContaining('finish-logout-render'))

    vi.clearAllMocks()
    setup({ baseURL: 'https://api/auth', mode: 'bff', ssrHydrate: false })
    expect(kit.addPlugin).toHaveBeenCalledTimes(2) // client + session.client only
    expect(kit.addPlugin).not.toHaveBeenCalledWith(expect.objectContaining({ mode: 'server' }))
    expect(kit.addServerPlugin).toHaveBeenCalledWith(expect.stringContaining('finish-logout-render'))

    vi.clearAllMocks()
    setup({ baseURL: 'https://api/auth', mode: 'direct' })
    expect(kit.addServerPlugin).not.toHaveBeenCalledWith(expect.stringContaining('finish-logout-render'))
  })

  it('registers the app-API proxy when api.{path,target} are set in bff mode', () => {
    const nuxt = setup({ baseURL: 'https://api/auth', mode: 'bff', api: { path: '/api', target: 'https://laravel.test' } })
    // bff proxy + app proxy
    expect(kit.addServerHandler).toHaveBeenCalledTimes(3)
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
    expect(kit.addServerHandler).toHaveBeenCalledTimes(2) // just the bff proxy and its logout middleware
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

  it('throws at setup on a baseURL that is not a valid absolute URL', () => {
    // The incident shape: an unset build-time env var interpolated as "undefined". Non-empty, so
    // the falsiness check missed it and it only failed at request time as an opaque 400.
    expect(() => setup({ baseURL: 'undefined/admin/auth', mode: 'bff' })).toThrow(/not a valid absolute URL/)
    // The message must name the offending value so the fix is obvious from the build log.
    expect(() => setup({ baseURL: 'undefined/admin/auth', mode: 'bff' })).toThrow(/undefined\/admin\/auth/)
    expect(() => setup({ baseURL: '/relative', mode: 'bff' })).toThrow(/not a valid absolute URL/)
    expect(() => setup({ baseURL: 'localhost:3000/auth', mode: 'bff' })).toThrow(/not a valid absolute URL/)
  })

  it('accepts a valid absolute baseURL unchanged', () => {
    expect(() => setup({ baseURL: 'https://api.example.com/auth', mode: 'bff' })).not.toThrow()
    expect(() => setup({ baseURL: 'http://api.example.com/auth', mode: 'direct' })).not.toThrow()
  })

  it('allows a root-relative baseURL in direct mode only (the browser resolves it same-origin)', () => {
    expect(() => setup({ baseURL: '/auth', mode: 'direct' })).not.toThrow()
    expect(() => setup({ baseURL: '/auth', mode: 'bff' })).toThrow(/not a valid absolute URL/)
    // Protocol-relative borrows the page's scheme but names another host — indistinguishable from
    // a typo'd path, and `originOf` can't parse it into an app-API base.
    expect(() => setup({ baseURL: '//evil.example.com/auth', mode: 'direct' })).toThrow(/not a valid absolute URL/)
    // Direct mode's message must mention the form it does accept.
    expect(() => setup({ baseURL: 'undefined/auth', mode: 'direct' })).toThrow(/root-relative path/)
  })

  it('derives an empty app-API base from a root-relative direct baseURL (not lukk\'s auth prefix)', () => {
    // `originOf('/auth')` has no origin to take: '' means "this origin" for useLukkFetch, whereas
    // returning '/auth' verbatim would aim every app-API call at lukk's auth prefix.
    const nuxt = setup({ baseURL: '/auth', mode: 'direct' })
    expect((nuxt.options.runtimeConfig.public.lukk as { apiBaseURL: string }).apiBaseURL).toBe('')
  })

  it('throws on an api.target that is not absolute, but only once the proxy is registered', () => {
    const withProxy = { baseURL: 'https://api/auth', mode: 'bff', api: { path: '/api', target: 'undefined/api' } }
    expect(() => setup(withProxy)).toThrow(/`api\.target`.*not a valid absolute URL/s)
    // Half-configured (no path) → the proxy isn't registered, so the value is inert: warn, not throw.
    expect(() => setup({ baseURL: 'https://api/auth', mode: 'bff', api: { target: 'undefined/api' } })).not.toThrow()
  })

  it('validates api.target in direct mode too, where it becomes the browser app-API base', () => {
    // Not proxied in direct mode, but it still ships as `apiBaseURL` — so a bogus value is just as
    // broken, while a same-origin `/api` is legitimate there.
    expect(() => setup({ baseURL: 'https://api/auth', mode: 'direct', api: { target: 'undefined/api' } })).toThrow(/`api\.target`/)
    expect(() => setup({ baseURL: 'https://api/auth', mode: 'direct', api: { target: '/api' } })).not.toThrow()
  })

  it('validates the EFFECTIVE baseURL, so a direct runtimeConfig override cannot slip past', () => {
    // defu gives an existing `runtimeConfig` value precedence over the module option, so validating
    // only `options.baseURL` would bless a value the proxies never use.
    expect(() => setup(
      { baseURL: 'https://good.example.com/auth', mode: 'bff' },
      { runtimeConfig: { public: {}, lukk: { baseURL: 'undefined/auth' } } },
    )).toThrow(/not a valid absolute URL/)
  })

  it('throws when baseURL carries a query or fragment (it would swallow the request path)', () => {
    // Not a warning: the path is appended AFTER the query, so every route resolves to the same
    // upstream URL — including `/logout`, which would clear the local session while the token
    // family stays live at lukk. There's no legitimate use for it.
    expect(() => setup({ baseURL: 'https://api.example.com/auth?tenant=1', mode: 'bff' })).toThrow(/carries a query or fragment/)
    expect(() => setup({ baseURL: 'https://api.example.com/auth#x', mode: 'bff' })).toThrow(/carries a query or fragment/)
  })

  it('never echoes credentials from a base into a build log', () => {
    // These messages land in CI logs and, in dev, the browser error overlay.
    expect(() => setup({ baseURL: 'https://user:hunter2@api.example.com/auth?t=1', mode: 'bff' }))
      .toThrow(/\/\/\*\*\*@api\.example\.com/)
    expect(() => setup({ baseURL: 'https://user:hunter2@api.example.com/auth?t=1', mode: 'bff' }))
      .not.toThrow(/hunter2/)
  })

  it('reports rather than throws during `nuxt prepare`, so postinstall/typecheck still work', () => {
    // `nuxt prepare` runs every module setup just to generate types and is wired into postinstall
    // in the Nuxt starters — throwing there would break `pnpm install` on a fresh clone that has
    // no .env yet. A real build must still be fatal.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => setup({ baseURL: 'undefined/auth', mode: 'bff' }, { _prepare: true })).not.toThrow()
    expect(error.mock.calls.some(c => String(c[0]).includes('not a valid absolute URL'))).toBe(true)
    error.mockRestore()
    expect(() => setup({ baseURL: 'undefined/auth', mode: 'bff' })).toThrow()
  })

  it('warns when a bff build exposes the lukk URL to the browser via a public override', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    setup(
      { baseURL: 'https://api/auth', mode: 'bff' },
      { runtimeConfig: { public: { lukk: { baseURL: 'https://api/auth' } }, lukk: {} } },
    )
    expect(warn.mock.calls.some(c => String(c[0]).includes('meant to stay server-side'))).toBe(true)
    warn.mockRestore()
  })

  it('validates the effective apiBaseURL, which scopes the bearer in useLukkFetch', () => {
    // Written through defu, so a direct override would otherwise bypass every check above and
    // could aim credentialed requests at another origin.
    expect(() => setup(
      { baseURL: 'https://api/auth', mode: 'direct' },
      { runtimeConfig: { public: { lukk: { apiBaseURL: '//evil.example.com' } }, lukk: {} } },
    )).toThrow(/apiBaseURL/)
  })

  it('warns when a production build points baseURL at loopback (a dev value that leaked)', () => {
    const warned = (o: Parameters<typeof setup>[0], nuxtOptions: Record<string, unknown> = {}) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      setup(o, nuxtOptions)
      const hit = warn.mock.calls.some(c => String(c[0]).includes('production build'))
      warn.mockRestore()
      return hit
    }
    expect(warned({ baseURL: 'http://localhost:8000/auth', mode: 'bff' })).toBe(true)
    expect(warned({ baseURL: 'http://127.0.0.1:8000/auth', mode: 'bff' })).toBe(true)
    // Not a production build, and not loopback → silent.
    expect(warned({ baseURL: 'http://localhost:8000/auth', mode: 'bff' }, { dev: true })).toBe(false)
    expect(warned({ baseURL: 'https://api.example.com/auth', mode: 'bff' })).toBe(false)
    // A root-relative direct-mode base has no hostname to inspect — must not warn or throw.
    expect(warned({ baseURL: '/auth', mode: 'direct' })).toBe(false)
  })

  it('passes clientIpHeader through lower-cased, and defaults to off', () => {
    // Node lower-cases incoming header names, so the runtime lookup only matches lower-case.
    const off = setup({ baseURL: 'https://api/auth', mode: 'bff' })
    expect((off.options.runtimeConfig.lukk as { clientIpHeader: string }).clientIpHeader).toBe('')
    const on = setup({ baseURL: 'https://api/auth', mode: 'bff', clientIpHeader: 'CF-Connecting-IP' })
    expect((on.options.runtimeConfig.lukk as { clientIpHeader: string }).clientIpHeader).toBe('cf-connecting-ip')
  })

  it('warns when clientIpHeader names an append-style header (spoofable), not a set-style one', () => {
    const warned = (clientIpHeader: string) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      setup({ baseURL: 'https://api/auth', mode: 'bff', clientIpHeader })
      const hit = warn.mock.calls.some(c => String(c[0]).includes('append-style'))
      warn.mockRestore()
      return hit
    }
    // Trusting an append-style chain re-opens the very spoofing the default blanking prevents.
    expect(warned('x-forwarded-for')).toBe(true)
    expect(warned('X-Forwarded-For')).toBe(true)
    expect(warned('forwarded')).toBe(true)
    expect(warned('cf-connecting-ip')).toBe(false)
    expect(warned('')).toBe(false)
  })

  it('warns that clientIpHeader is dead config in direct mode', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    setup({ baseURL: 'https://api/auth', mode: 'direct', clientIpHeader: 'cf-connecting-ip' })
    // No proxy hop in direct mode — the browser reaches the API itself, so the API already sees it.
    expect(warn.mock.calls.some(c => String(c[0]).includes('only applies in bff mode'))).toBe(true)
    warn.mockRestore()
  })

  it('fails the build on an unusable confirmationHeader', () => {
    const bad = (confirmationHeader: string) => () => setup({ baseURL: 'https://api/auth', mode: 'bff', confirmationHeader })
    // It becomes a computed header key; `Headers.set` rejects '' or a spaced value, which would 502
    // EVERY proxied request with nothing pointing at the cause.
    expect(bad('')).toThrow(/must be a valid HTTP header name/)
    expect(bad('X Lukk')).toThrow(/must be a valid HTTP header name/)
    // A name the proxies set themselves breaks silently instead: the app-API proxy overwrites the
    // token (step-up stops working), and the auth proxy would clobber Accept/Content-Type.
    expect(bad('Authorization')).toThrow(/must be a valid HTTP header name/)
    expect(bad('accept')).toThrow(/must be a valid HTTP header name/)
    expect(bad('X-Forwarded-For')).toThrow(/must be a valid HTTP header name/)
    expect(bad('X-Step-Up')).not.toThrow()
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

describe('session secret and user endpoint validation', () => {
  const base = { baseURL: 'https://api.example.com/auth', mode: 'bff' }

  it('refuses a session secret shorter than iron will accept', () => {
    // The length was documented and enforced nowhere. iron rejects it at write time, so the old
    // failure mode was safe but awful: every login and refresh 500s, discovered in production.
    expect(() => setup({ ...base, session: { password: 'a'.repeat(31) } })).toThrow(/at least 32 characters/)
    // Nothing derived from the secret — not even its length — reaches the message.
    expect(() => setup({ ...base, session: { password: 'a'.repeat(31) } })).not.toThrow(/31/)
    expect(() => setup({ ...base, session: { password: 'a'.repeat(32) } })).not.toThrow()
  })

  it('validates user.endpoint like every other base, and pins it same-origin in bff mode', () => {
    // It had no validation at all — not even the "undefined/me" unset-env-var check — while being
    // fetched with an EMPTY base and the sealed session cookie attached, on every SSR render.
    const session = { password: 'a'.repeat(32) }

    expect(() => setup({ ...base, session, user: { endpoint: 'undefined/me' } })).toThrow(/not a valid absolute URL/)
    expect(() => setup({ ...base, session, user: { endpoint: 'https://elsewhere.test/me' } })).toThrow(/same-origin path in bff mode/)
    expect(() => setup({ ...base, session, user: { endpoint: '/api/me' } })).not.toThrow()

    // Direct mode legitimately points at another origin — that's where the app's API lives.
    expect(() => setup({ baseURL: 'https://api.example.com/auth', mode: 'direct', user: { endpoint: 'https://api.example.com/me' } })).not.toThrow()
  })
})

describe('lukk-nuxt module — what it registers, and when it speaks up', () => {
  const password = 'x'.repeat(32)
  /** Every warning one setup prints. */
  function warnings(overrides: Record<string, unknown>, nuxtOptions: Record<string, unknown> = {}): string[] {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      setup(overrides, nuxtOptions)
      return warn.mock.calls.map(c => String(c[0]))
    }
    finally { warn.mockRestore() }
  }
  const says = (list: string[], fragment: string) => list.some(w => w.includes(fragment))

  it('declares itself, and ships the documented defaults', () => {
    const mod = lukkModule as unknown as { meta: unknown, defaults: unknown }
    expect(mod.meta).toEqual({ name: 'lukk-nuxt', configKey: 'lukk', compatibility: { nuxt: '>=3.13.0' } })
    expect(mod.defaults).toEqual({
      baseURL: '',
      mode: 'bff',
      ssrHydrate: true,
      confirmationHeader: 'X-Lukk-Confirmation',
      storage: 'cookie',
      user: { endpoint: '' },
      session: { password: '' },
      api: { path: '', target: '', forceJson: true, forwardSetCookie: [] },
      clientIpHeader: '',
    })
  })

  it('registers exactly its composables, server utils, route middleware, plugins and handlers', () => {
    setup({ baseURL: 'https://api/auth', mode: 'bff', session: { password }, api: { path: '/api/', target: 'https://laravel.test' } })

    expect(kit.addImportsDir.mock.calls).toEqual([['./runtime/composables']])
    expect(kit.addServerImportsDir.mock.calls).toEqual([['./runtime/server/utils']])
    expect(kit.addRouteMiddleware.mock.calls.map(c => c[0])).toEqual([
      { name: 'lukk-auth', path: './runtime/middleware/auth' },
      { name: 'lukk-guest', path: './runtime/middleware/guest' },
      { name: 'lukk-verified', path: './runtime/middleware/verified' },
      { name: 'lukk-confirmed', path: './runtime/middleware/confirmed' },
    ])
    expect(kit.addPlugin.mock.calls.map(c => c[0])).toEqual([
      './runtime/plugins/client',
      { src: './runtime/plugins/session.client', mode: 'client' },
      { src: './runtime/plugins/session.server', mode: 'server' },
    ])
    expect(kit.addServerHandler.mock.calls.map(c => c[0])).toEqual([
      { route: '/api/_lukk/**', handler: './runtime/server/bff' },
      { middleware: true, handler: './runtime/server/finish-logout' },
      { route: '/api/**', handler: './runtime/server/api-proxy' },
    ])
    expect(kit.addServerPlugin.mock.calls.map(c => c[0])).toEqual([
      './runtime/server/plugins/streaming-render',
      './runtime/server/plugins/finish-logout-render',
      './runtime/server/plugins/shared-ended-sessions',
    ])
  })

  it('types $lukk and $lukkRefresh on the NuxtApp', () => {
    setup({ baseURL: 'https://api/auth', mode: 'bff' })
    const template = kit.addTypeTemplate.mock.calls[0]![0] as { filename: string, getContents: () => string }

    expect(template.filename).toBe('types/lukk-nuxt.d.ts')
    expect(template.getContents()).toBe([
      `import type { LukkClient, TokenPair } from 'lukk-core'`,
      `declare module '#app' {`,
      `  interface NuxtApp {`,
      `    /** The lukk-core client, wired for the configured transport. */`,
      `    $lukk: LukkClient`,
      `    /** The shared single-flight refresh; \`null\` when the session can't be refreshed. */`,
      `    $lukkRefresh: () => Promise<TokenPair | null>`,
      `  }`,
      `}`,
      `export {}`,
      ``,
    ].join('\n'))
  })

  it('warns about a half-configured app-API proxy in bff mode only, and not when it is whole or absent', () => {
    const half = '`api.path` and `api.target`'
    expect(says(warnings({ baseURL: 'https://api/auth', mode: 'bff', session: { password }, api: { path: '/api' } }), half)).toBe(true)
    expect(says(warnings({ baseURL: 'https://api/auth', mode: 'bff', session: { password }, api: { target: 'https://l.test' } }), half)).toBe(true)
    expect(says(warnings({ baseURL: 'https://api/auth', mode: 'bff', session: { password }, api: { path: '/api', target: 'https://l.test' } }), half)).toBe(false)
    expect(says(warnings({ baseURL: 'https://api/auth', mode: 'bff', session: { password } }), half)).toBe(false)
    expect(says(warnings({ baseURL: 'https://api/auth', mode: 'direct', api: { path: '/api' } }), half)).toBe(false)
  })

  it('registers no app-API proxy when only half of it is configured', () => {
    for (const api of [{ path: '/api' }, { target: 'https://l.test' }]) {
      kit.addServerHandler.mockClear()
      warnings({ baseURL: 'https://api/auth', mode: 'bff', session: { password }, api })
      expect(kit.addServerHandler.mock.calls.map(c => (c[0] as { handler: string }).handler)).not.toContain('./runtime/server/api-proxy')
    }
  })

  it('gates each mode-specific warning on its mode', () => {
    // bff-only concerns stay quiet in direct mode, and the direct-only one in bff mode.
    expect(says(warnings({ baseURL: 'https://api/auth', mode: 'direct', clientIpHeader: 'x-forwarded-for' }), 'append-style')).toBe(false)
    expect(says(warnings({ baseURL: 'https://api/auth', mode: 'direct', session: { password: '', name: 'a b' } }), 'session.name')).toBe(false)
    expect(says(warnings({ baseURL: 'https://api/auth', mode: 'bff', session: { password }, clientIpHeader: 'cf-connecting-ip' }), 'only applies in bff mode')).toBe(false)
    expect(says(warnings({ baseURL: 'https://api/auth', mode: 'direct' }), 'only applies in bff mode')).toBe(false)
    expect(says(warnings({ baseURL: 'https://api/auth', mode: 'direct' }), 'session secret')).toBe(false)
  })

  it('names the missing session secret, and an unset baseURL', () => {
    const saved = process.env.NUXT_LUKK_SESSION_PASSWORD
    delete process.env.NUXT_LUKK_SESSION_PASSWORD
    try {
      expect(warnings({ baseURL: 'https://api/auth', mode: 'bff' })).toContain('[lukk-nuxt] BFF mode needs a session secret (≥ 32 chars) — set `session.password` or NUXT_LUKK_SESSION_PASSWORD.')
      expect(says(warnings({ baseURL: 'https://api/auth', mode: 'bff', session: { password } }), 'session secret')).toBe(false)
    }
    finally { if (saved !== undefined) process.env.NUXT_LUKK_SESSION_PASSWORD = saved }
    expect(warnings({ baseURL: '', mode: 'direct' })).toContain('[lukk-nuxt] `baseURL` is not set — point it at your lukk auth URL.')
  })

  it('explains a short secret, a broken base and a base with a query, and names which setting', () => {
    expect(() => setup({ baseURL: 'https://api/auth', mode: 'bff', session: { password: 'short' } })).toThrow(/the BFF equivalent of Laravel's APP_KEY/)
    expect(() => setup({ baseURL: 'undefined/auth', mode: 'direct' })).toThrow(/^\[lukk-nuxt\] `baseURL` "undefined\/auth" is not a valid absolute URL\. It must start with http:\/\/ or https:\/\/, or be a root-relative path like "\/auth"\. A common cause is an unset build-time env var interpolating as "undefined" \(e\.g\. `\$\{process\.env\.API_URL\}\/auth`\)\. If you build once and supply the URL per environment, leave it empty and set NUXT_LUKK_BASE_URL at runtime instead\.$/)
    // bff fetches the base server-side, where no relative form exists — so the message offers none.
    expect(() => setup({ baseURL: 'undefined/auth', mode: 'bff', session: { password } })).toThrow(/It must start with http:\/\/ or https:\/\/\. A common cause/)
    expect(() => setup({ baseURL: 'https://api/auth?x=1', mode: 'bff', session: { password } })).toThrow(/^\[lukk-nuxt\] `baseURL` "https:\/\/api\/auth\?x=1" carries a query or fragment\. The request path is appended after it, so every call would resolve to the wrong URL\. Use only the scheme, host and path\.$/)
    expect(() => setup({ baseURL: 'https://api/auth', mode: 'bff', session: { password }, user: { endpoint: 'undefined/me' } })).toThrow(/`user\.endpoint` "undefined\/me"/)
    expect(() => setup({ baseURL: 'https://api/auth', mode: 'bff', session: { password }, user: { endpoint: 'https://api/me' } })).toThrow(/it is fetched server-side with the sealed session cookie attached\./)
  })

  it('warns when the public config exposes the lukk URL in bff mode, never in direct mode', () => {
    const exposed = (mode: string) => says(warnings({ baseURL: 'https://api/auth', mode, session: { password } }, { runtimeConfig: { public: { lukk: { baseURL: 'https://api/auth' } } } }), 'meant to stay server-side')
    expect(exposed('bff')).toBe(true)
    expect(exposed('direct')).toBe(false)
  })

  it.each([
    'http://localhost:8000', 'http://app.localhost', 'http://127.0.0.1:8000', 'http://127.9.9.9', 'http://[::1]:8000', 'http://0.0.0.0:8000',
  ])('warns that a production build points at this machine: %s', (base) => {
    expect(says(warnings({ baseURL: base, mode: 'bff', session: { password } }), 'in a production build')).toBe(true)
  })

  it.each(['https://api.example.com', 'http://localhost.example.com', 'http://10.127.0.1', '/auth'])('does not call %s this machine', (base) => {
    expect(says(warnings({ baseURL: base, mode: 'direct' }), 'in a production build')).toBe(false)
  })
})
