import type { $Fetch } from 'ofetch'
import { createFetch, Headers as OFetchHeaders } from 'ofetch'
import { describe, expect, it, vi } from 'vitest'
import { createLukkFetch, createRequestFetch, type LukkFetchDeps, type RequestFetch } from '../src/runtime/utils/create-lukk-fetch'

/**
 * The credential decision, driven through REAL ofetch.
 *
 * Every other test here hands `onRequest` a context it built itself — which is faster, but it is also a
 * second implementation of ofetch's option merging, and the two disagreed on the case that mattered:
 * those contexts carry no `baseURL` at all, while the real library ALWAYS merges the instance default
 * in, so the branch that judges a per-call base was never entered. A rule that refused the bearer on
 * every ordinary direct-mode app shipped with 697 green tests and 100% coverage.
 *
 * So this file asserts on what actually leaves the process: the URL, the headers and `credentials` as
 * ofetch hands them to `fetch`. Keep it small — it exists to catch the mock drifting from the library,
 * not to re-test every rule.
 */
function drive(overrides: Partial<LukkFetchDeps> = {}, respond = () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })) {
  const seen: { url: string, headers: Headers, credentials?: string }[] = []
  const fetchImpl = createFetch({
    fetch: (async (input: string | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.url
      seen.push({ url, headers: new Headers(init?.headers as HeadersInit), credentials: init?.credentials })
      return respond()
    }) as typeof globalThis.fetch,
    Headers: OFetchHeaders as unknown as typeof globalThis.Headers,
  }) as unknown as $Fetch

  const api = createLukkFetch({
    baseURL: 'https://api.example.com',
    isServer: false,
    canRefresh: false,
    getCookieHeader: () => undefined,
    getBearer: () => 'SECRET',
    getConfirmation: () => null,
    confirmationHeader: 'X-Lukk-Confirmation',
    refresh: vi.fn(async () => ({ access_token: 'new' })),
    onRedirect: vi.fn(),
    fetchImpl,
    ...overrides,
  })

  return { api, seen, fetchImpl }
}

describe('createLukkFetch through real ofetch', () => {
  it('attaches the bearer to the user endpoint loadUser asks for', async () => {
    // `loadUser` passes `{ baseURL: '' }` so a configured absolute `user.endpoint` is left as-is. Read as
    // a relative base it was refused against an absolute API base, and direct mode could never load a
    // user: 401, a refresh rotation spent on the retry, 401 again, then back to /login.
    const { api, seen } = drive()

    await api('https://api.example.com/api/me', { baseURL: '' })

    expect(seen[0]!.url).toBe('https://api.example.com/api/me')
    expect(seen[0]!.headers.get('authorization')).toBe('Bearer SECRET')
    expect(seen[0]!.credentials).toBe('include')
  })

  it('still refuses a cross-origin per-call base, with the instance default merged in as ofetch does it', async () => {
    const { api, seen } = drive()

    await api('/me', { baseURL: 'https://collector.example' })

    expect(seen[0]!.url).toBe('https://collector.example/me')
    expect(seen[0]!.headers.get('authorization')).toBeNull()
    expect(seen[0]!.credentials).toBe('same-origin')
  })

  it('refuses a boxed-string per-call base that the library resolves to another host', async () => {
    // The rule leans on ufo: it resolves `new String(url)` exactly like the string, so a check that
    // skipped non-strings as "no base" cleared a request that then left for that host with the bearer.
    const { api, seen } = drive()

    await api('/me', { baseURL: new String('https://collector.example') as unknown as string })

    expect(seen[0]!.url).toBe('https://collector.example/me')
    expect(seen[0]!.headers.get('authorization')).toBeNull()
    expect(seen[0]!.credentials).toBe('same-origin')
  })

  it('refuses a base whose string forms disagree — ufo coerces it twice, with different hints', async () => {
    // `endsWith` takes `toString`, the `+` in `joinURL` takes `valueOf`: judged by `String()`, this object
    // passed as the API while the request left for the other host with the bearer.
    class TwoFaced extends String {
      override toString() { return 'https://api.example.com' }
    }
    const { api, seen } = drive()

    await api('/me', { baseURL: new TwoFaced('https://collector.example') as unknown as string })

    expect(seen[0]!.url).toBe('https://collector.example/me')
    expect(seen[0]!.headers.get('authorization')).toBeNull()
  })

  it('keeps redirect: manual even when the caller asks to follow', async () => {
    // ofetch spreads per-call options over the instance defaults, so `redirect` living only in the
    // defaults was caller-overridable — and a 307/308 preserves the method AND body across origins
    // (RFC 9110 §15.4.8-9). The browser strips `Authorization` on a cross-origin redirect; it does not
    // strip a credential in the body. Both sibling fetches already pin it after the caller's options.
    const seen: RequestInit[] = []
    const fetchImpl = createFetch({
      fetch: (async (_input: string | Request, init?: RequestInit) => {
        seen.push(init ?? {})
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
      }) as typeof globalThis.fetch,
      Headers: OFetchHeaders as unknown as typeof globalThis.Headers,
    }) as unknown as $Fetch

    const api = createLukkFetch({
      baseURL: 'https://api.example.com',
      isServer: false,
      canRefresh: false,
      getCookieHeader: () => undefined,
      getBearer: () => 'SECRET',
      getConfirmation: () => null,
      confirmationHeader: 'X-Lukk-Confirmation',
      refresh: vi.fn(async () => ({ access_token: 'new' })),
      onRedirect: vi.fn(),
      fetchImpl,
    })

    await api('/me', { redirect: 'follow' } as Parameters<typeof api>[1])

    expect(seen[0]!.redirect).toBe('manual')
  })

  it('attaches on the plain path, where the instance base is the only one in play', async () => {
    const { api, seen } = drive()

    await api('/me')

    expect(seen[0]!.url).toBe('https://api.example.com/me')
    expect(seen[0]!.headers.get('authorization')).toBe('Bearer SECRET')
    expect(seen[0]!.credentials).toBe('include')
  })

  it('keeps an Accept the caller set, and asks for JSON only when there is none', async () => {
    // Forced unconditionally, it clobbered the caller's choice — the documented `api.forceJson: false`
    // escape hatch for a non-JSON route could not be used through `useLukkFetch` at all.
    const { api, seen } = drive()

    await api('/report.csv', { headers: { Accept: 'text/csv' } })
    await api('/me')

    expect(seen[0]!.headers.get('accept')).toBe('text/csv')
    expect(seen[1]!.headers.get('accept')).toBe('application/json')
  })
})

describe('the visitor\'s cookies, on the server', () => {
  // On SSR, `getCookieHeader` is EVERY cookie the browser sent this app — analytics, CSRF, a co-hosted
  // app's session. They belong to the app's origin. The only place they may go is the app itself (the
  // BFF proxy mount, resolved in-process); an absolute API is another host, whose own cookies the browser
  // never sent here in the first place.
  const server = { isServer: true, getBearer: () => null, getCookieHeader: () => '_ga=GA1; XSRF-TOKEN=x; other-app-session=s' }

  it('are never sent to an absolute API base (direct mode)', async () => {
    const { api, seen } = drive({ ...server, baseURL: 'https://api.example.com' })

    await api('/me')
    await api('https://api.example.com/me')

    expect(seen.map(s => s.url)).toEqual(['https://api.example.com/me', 'https://api.example.com/me'])
    expect(seen.map(s => s.headers.get('cookie'))).toEqual([null, null])
  })

  it('go to the app\'s own proxy mount (bff mode)', async () => {
    const { api, seen } = drive({ ...server, baseURL: '/api' })

    await api('/me')

    expect(seen[0]!.url).toBe('/api/me')
    expect(seen[0]!.headers.get('cookie')).toBe('_ga=GA1; XSRF-TOKEN=x; other-app-session=s')
  })

  it('never follow the request\'s own idea of this app\'s origin to an absolute URL', async () => {
    // On the server, `origin` is read from `Host` / `X-Forwarded-*` — whatever the request said. Trusted,
    // an absolute URL on a host the request named was cleared as "this app" and handed the sealed session.
    const { api, seen } = drive({ ...server, baseURL: '/api', origin: 'https://evil.example' })

    await api('https://evil.example/collect')
    await api('/me', { baseURL: 'https://evil.example/api' })

    expect(seen.map(s => s.headers.get('cookie'))).toEqual([null, null])
    expect(seen.map(s => s.credentials)).toEqual(['same-origin', 'same-origin'])
  })
})

describe('createLukkFetch through real ofetch — errors, the step-up token, an empty base', () => {
  it('keeps the server\'s Retry-After on the LukkError, in seconds — as lukk-core does', async () => {
    const { api } = drive({}, () => new Response('{"message":"Busy"}', { status: 503, headers: { 'content-type': 'application/json', 'retry-after': '7' } }))
    await expect(api('/me')).rejects.toMatchObject({ status: 503, message: 'Busy', retryAfter: 7 })

    const { api: dated } = drive({}, () => new Response('{}', { status: 503, headers: { 'content-type': 'application/json', 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' } }))
    await expect(dated('/me')).rejects.not.toHaveProperty('retryAfter')
  })

  it('attaches the held step-up token on the API\'s own origin, and never elsewhere (direct mode)', async () => {
    // A `lukk.confirm`-gated route of the app's own API answered 423 forever: nothing sent the token there.
    const { api, seen } = drive({ getConfirmation: () => 'CONFIRMED', confirmationHeader: 'X-Step-Up' })

    await api('/account')
    await api('/collect', { baseURL: 'https://collector.example' })

    expect(seen[0]!.headers.get('x-step-up')).toBe('CONFIRMED')
    expect(seen[1]!.headers.get('x-step-up')).toBeNull()

    // And none at all when none is held — not the string "null".
    const empty = drive()
    await empty.api('/account')
    expect(empty.seen[0]!.headers.has('x-lukk-confirmation')).toBe(false)
  })

  it('sends no credential for a relative path with an explicitly EMPTY base, when that lands on another origin', async () => {
    // `''` stops ofetch joining, so `/me` goes to the PAGE's origin — not the API's when the API is absolute.
    const away = drive({ origin: 'https://app.example.com' })
    await away.api('/me', { baseURL: '' })
    expect(away.seen[0]!.url).toBe('/me')
    expect(away.seen[0]!.headers.get('authorization')).toBeNull()
    expect(away.seen[0]!.credentials).toBe('same-origin')

    // …but when the page IS on the API's origin, or the API base is relative, that is the API.
    const same = drive({ origin: 'https://api.example.com' })
    await same.api('/me', { baseURL: '' })
    expect(same.seen[0]!.headers.get('authorization')).toBe('Bearer SECRET')
    const relative = drive({ baseURL: '/api', origin: 'https://app.example.com' })
    await relative.api('/me', { baseURL: '' })
    expect(relative.seen[0]!.headers.get('authorization')).toBe('Bearer SECRET')
    // On the server the page's origin is the request's Host — not ours to trust.
    const server = drive({ origin: 'https://api.example.com', isServer: true })
    await server.api('/me', { baseURL: '' })
    expect(server.seen[0]!.headers.get('authorization')).toBeNull()
  })
})

describe('the SSR instance\'s headers, as the browser\'s ofetch instance merges them', () => {
  // The browser gets a real ofetch instance; the server a `$Fetch` of our own over Nuxt's request-aware fetch.
  // A call's `headers` used to REPLACE the instance's (`api.create({ headers: { 'x-tenant': 'a' } })` lost
  // `x-tenant` on any call passing its own) — during SSR only, since ofetch merges them. Both are driven
  // here through the same real ofetch and compared on what reaches `fetch`.
  type Init = HeadersInit | undefined
  const bff = { baseURL: '/api', getBearer: () => null }

  async function both(scope: (api: $Fetch) => $Fetch, call: Init) {
    const browser = drive(bff)
    await scope(browser.api)('/me', call === undefined ? {} : { headers: call })
    // Nuxt's request-aware fetch is a plain ofetch: the auth options come from `createRequestFetch` alone.
    const server = drive()
    const deps = { ...bff, isServer: true, canRefresh: false, getCookieHeader: () => undefined, getConfirmation: () => null, confirmationHeader: 'X-Lukk-Confirmation', refresh: vi.fn(), onRedirect: vi.fn(), fetchImpl: server.fetchImpl }
    const ssr = createRequestFetch(server.fetchImpl as unknown as RequestFetch, deps)
    await scope(ssr)('/me', call === undefined ? {} : { headers: call })
    const strip = (headers: Headers) => Object.fromEntries([...headers].filter(([name]) => name !== 'x-lukk-ssr'))
    return { browser: strip(browser.seen[0]!.headers), server: strip(server.seen[0]!.headers) }
  }

  const defaults: [string, Init][] = [
    ['a record', { 'x-tenant': 'a', 'X-Over': 'default' }],
    ['a Headers', new Headers({ 'x-tenant': 'a', 'x-over': 'default' })],
    ['tuples', [['x-tenant', 'a'], ['X-OVER', 'default']]],
    ['none', undefined],
  ]
  const calls: [string, Init][] = [
    ['a record', { 'x-trace': 'b', 'x-over': 'call' }],
    ['a Headers', new Headers({ 'x-trace': 'b', 'X-Over': 'call' })],
    ['tuples', [['x-trace', 'b'], ['x-over', 'first'], ['x-over', 'call']]],
    ['none', undefined],
  ]

  for (const [defaultForm, instance] of defaults) {
    for (const [callForm, call] of calls) {
      it(`merges ${callForm} on the call over ${defaultForm} on the instance, case-insensitively, the call winning`, async () => {
        const { browser, server } = await both(api => api.create(instance === undefined ? {} : { headers: instance }), call)
        expect(server).toEqual(browser)
        if (instance !== undefined) expect(server['x-tenant']).toBe('a')
        if (call !== undefined) expect(server['x-trace']).toBe('b')
      })
    }
  }

  it('lets a nested .create() replace the headers it names, and inherit them when it names none — as ofetch does', async () => {
    // ofetch spreads a nested `create`'s defaults over the instance's: a `headers` there REPLACES the outer one.
    // The server instance does what the browser's does, whichever way that is.
    const replaced = await both(api => api.create({ headers: { 'x-tenant': 'a' } }).create({ headers: { 'x-nested': 'c' } }), { 'x-trace': 'b' })
    expect(replaced.server).toEqual(replaced.browser)
    expect(replaced.server['x-nested']).toBe('c')
    const inherited = await both(api => api.create({ headers: { 'x-tenant': 'a' } }).create({ retry: 0 }), { 'x-trace': 'b' })
    expect(inherited.server).toEqual(inherited.browser)
    expect(inherited.server['x-tenant']).toBe('a')
  })
})
